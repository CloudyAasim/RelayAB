/**
 * app/api/assistant/chat/route.ts
 *
 * The assistant turn endpoint.
 *
 *   POST /api/assistant/chat
 *   Body: { message: string, threadId?: string, relayKey?: string }
 *   → text/event-stream
 *
 * `relayKey` is the caller's own `sk-relay-…` gateway key. It is used by the
 * `test_gateway_model` tool for the duration of this request and is never
 * written to the database or echoed back — which is why the model testing page
 * re-sends it per call instead of storing it.
 *
 * The stream carries four event types:
 *   delta  — a slice of assistant text, as it arrives
 *   tool   — the model asked for a tool; `toolName` says which
 *   action — a proposed change is waiting for the admin to confirm it
 *   error  — the turn failed; no `done` follows
 *   done   — the turn is complete
 */
import { getCurrentUser } from "@/lib/auth/session";
import { getAssistantSettings } from "@/lib/db/assistant";
import {
  createAssistantThread,
  getAssistantThread,
  setAssistantThreadWebSearch,
} from "@/lib/db/assistant";
import { runChat, type ChatEvent } from "@/lib/assistant/chat";
import { resolveAssistantConfig } from "@/lib/assistant/config";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { UpstreamError } from "@/lib/assistant/client";
import { proxyChatCompletion } from "@/lib/proxy/chat";
import type { ChatCompletionRequest } from "@/lib/proxy/types";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import { listClientModelIds } from "@/lib/proxy/model-catalog";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import { resolvePublicUrl } from "@/lib/public-url";
import { getServerLocale } from "@/lib/i18n/server";
import { translate, type Locale } from "@/lib/i18n/dict";
import { getSettings } from "@/lib/db/settings";
import { saveAssistantArtifact, artifactRef } from "@/lib/db/assistant-artifacts";
import type { MessageAttachment } from "@/lib/assistant/schema";
import { loadSearchConfig } from "@/lib/search/config";
import { useOwnSearchService } from "@/lib/search/user";
import { DEFAULT_WEB_SEARCH_LIMIT } from "@/lib/search/usage";

export const dynamic = "force-dynamic";

/**
 * How often a silent turn says something anyway.
 *
 * Sized against the *smallest* read timeout this app has to survive rather than
 * the largest: nginx defaults to 60s and this deployment is documented to raise
 * it to 600s. A value comfortably under both means the number does not have to
 * be re-tuned whenever the proxy is reconfigured.
 */
const KEEPALIVE_MS = 25_000;

/**
 * One assistant turn, run through this deployment's own proxy.
 *
 * The account credential cannot be sent over HTTP — its row keeps only a sha256
 * of a secret that was discarded at creation — so the proxy is called directly
 * with the `ApiKey` and `User` objects, which is the whole reason that row
 * exists. The response is handed back as the byte stream `callAssistantModel`
 * expects, so delta reassembly and tool-call stitching are the same code on both
 * paths rather than a second implementation of them.
 *
 * `UpstreamError` is thrown rather than a Response returned because the caller's
 * error reporting is written against it, and a failed turn must read as "上游调用
 * 失败（HTTP …）" on the account path too rather than as a generic stream error.
 */
function accountTransport(
  account: {
    apiKey: import("@/lib/db/types").ApiKey;
    user: import("@/lib/db/types").User;
  },
  locale: Locale,
): import("@/lib/assistant/client").UpstreamTransport {
  return async ({ body, signal }) => {
    const req = body as ChatCompletionRequest;
    const result = await proxyChatCompletion({ req, apiKey: account.apiKey, user: account.user, signal });
    const res = proxyResultToResponse(result, { streamRequest: true });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(
        text.slice(0, 400) || translate(locale, "assistant.message.upstreamStatus", { status: res.status }),
        res.status,
        text,
      );
    }
    if (!res.body) {
      throw new UpstreamError(translate(locale, "assistant.message.upstreamNoStream"), 502);
    }
    return res.body;
  };
}

/**
 * No ceiling on the message itself.
 *
 * There was one, at 8,000 characters, and it was about two percent of the
 * smallest model on this deployment — a 204,800-token window turned into room
 * for two or three thousand. It also fired *before* the request left, so the
 * application was refusing work that the model had already agreed to do, and a
 * person pasting a stack trace or a log got a refusal instead of a reading.
 *
 * The context window is the model's to enforce, and it is better at it than a
 * character count is: characters do not mean the same thing in two languages,
 * and a fixed number cannot know how much of the window this conversation has
 * already spent. If the input genuinely does not fit, the upstream says so and
 * the turn is reported the way any other upstream failure is.
 *
 * Long content goes in a file. The attachment ceiling below is 25 MB and has no
 * equivalent ceiling on the text beside it, which is the right shape for it:
 * nobody pastes a repository, and everybody who needs to has a way out.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

/**
 * What the browser is allowed to send.
 *
 * Only images and audio/video are stored, and only the types the artifact
 * pipeline already knows how to serve. Everything else is refused by name
 * rather than accepted and then discovered: an attachment nothing can render is
 * a row the conversation carries forever and nobody can see.
 */
const ATTACHMENT_KINDS: Record<string, "image" | "audio" | "video"> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "audio/webm": "audio",
  "audio/ogg": "audio",
  "video/mp4": "video",
  "video/webm": "video",
};

interface UploadedFile {
  name: string;
  contentType: string;
  kind: "image" | "audio" | "video";
  bytes: Uint8Array;
}

function badRequest(code: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

/**
 * Read the `attachments` field.
 *
 * Base64 in JSON rather than multipart, because this request also carries the
 * message, the thread and the credential choice, and turning the whole turn
 * into a multipart form would mean a second parser for the common case that
 * has no files at all.
 */
function readAttachments(
  value: unknown,
  locale: Locale,
): { files: UploadedFile[] } | { error: Response } {
  if (value === undefined || value === null) return { files: [] };
  if (!Array.isArray(value)) {
    return {
      error: badRequest(
        "bad_request",
        translate(locale, "assistant.error.attachmentsNotArray"),
      ),
    };
  }
  if (value.length > MAX_ATTACHMENTS) {
    return {
      error: badRequest(
        "too_many_attachments",
        translate(locale, "assistant.error.tooManyAttachments", { max: MAX_ATTACHMENTS }),
      ),
    };
  }

  const files: UploadedFile[] = [];
  for (const raw of value) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const contentType = typeof row.contentType === "string" ? row.contentType.toLowerCase().trim() : "";
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 200) : "upload";
    const kind = ATTACHMENT_KINDS[contentType];
    if (!kind) {
      return {
        error: badRequest(
          "unsupported_attachment",
          translate(locale, "assistant.error.unsupportedAttachment", {
            name,
            type: contentType || translate(locale, "assistant.upload.unknownType"),
          }),
        ),
      };
    }
    if (typeof row.data !== "string" || !row.data) {
      return {
        error: badRequest(
          "bad_request",
          translate(locale, "assistant.error.attachmentEmpty", { name }),
        ),
      };
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(row.data, "base64"));
    } catch {
      return {
        error: badRequest(
          "bad_request",
          translate(locale, "assistant.error.attachmentNotBase64", { name }),
        ),
      };
    }
    if (bytes.byteLength === 0) {
      return {
        error: badRequest(
          "bad_request",
          translate(locale, "assistant.error.attachmentZeroLength", { name }),
        ),
      };
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return {
        error: badRequest(
          "attachment_too_large",
          translate(locale, "assistant.error.attachmentTooLarge", {
            name,
            max: `${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
          }),
        ),
      };
    }
    files.push({ name, contentType, kind, bytes });
  }
  return { files };
}

/** A thread opened by nothing but a file still needs a name a person can find. */
function firstUploadTitle(files: UploadedFile[], locale: Locale): string {
  const first = files[0];
  if (!first) return translate(locale, "assistant.newThread");
  return files.length > 1
    ? translate(locale, "assistant.thread.fileTitle", { name: first.name, count: files.length })
    : first.name.slice(0, 60);
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return Response.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  /**
   * The reader's language, resolved first.
   *
   * Every message this route refuses with is shown on screen, so it has to be
   * in the language the reader chose — not in the language the deployment
   * happens to be configured for. The cookie is the same one the interface
   * reads, so the two cannot disagree.
   */
  const locale = await getServerLocale();

  // Before anything is parsed, created or dialled. A turn costs this server an
  // open SSE connection and a SQLite write whatever the caller's own key pays
  // for upstream, and that was unbounded until now.
  const rate = consumeAssistantTurn(me.id);
  if (rate.limited) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: translate(locale, "assistant.error.rateLimited", {
            seconds: rate.retryAfterSeconds,
          }),
        },
      },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  let body: {
    message?: unknown;
    threadId?: unknown;
    relayKey?: unknown;
    attachments?: unknown;
    /** The composer's per-conversation web-search toggle. */
    webSearch?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  // Read before anything is created, so an unusable file leaves no thread and
  // no half-written turn behind.
  const uploads = readAttachments(body.attachments, locale);
  if ("error" in uploads) return uploads.error;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  // A turn of nothing but a picture is a normal thing to send, so it is
  // allowed — but only with files. An empty turn with nothing attached is a
  // mistake, and starting a thread for it would leave a question mark in the
  // user's history.
  if (!message && uploads.files.length === 0) {
    return Response.json(
      {
        ok: false,
        error: { code: "bad_request", message: translate(locale, "assistant.error.emptyMessage") },
      },
      { status: 400 },
    );
  }
  const relayKey = typeof body.relayKey === "string" && body.relayKey.trim()
    ? body.relayKey.trim()
    : undefined;

  /**
   * The credential, resolved before the configuration gate because the two
   * paths need different things from it: the key path reads a stored upstream,
   * the account path spends the credential the user already authorised and has
   * an upstream by construction.
   *
   * That credential has no plaintext — the row keeps only a sha256 of a secret
   * that was dropped at creation (`db/assistant-keys.ts`) — so it cannot be sent
   * as a bearer token. It goes to the proxy in-process instead, which is what
   * the tools have always done with it. `gatewayBase` is not the destination
   * here; the transport below is.
   *
   * **The mode is the stored one, not one the request names.** The browser used
   * to send it, which is how a mode could be chosen for one turn and forgotten
   * by the next: two sources of truth for one setting, and the one that did not
   * survive a refresh was the one the answer depended on.
   */
  const stored = await getAssistantSettings(me.id);
  const config = resolveAssistantConfig(stored);

  /**
   * Web search is resolved from three layers, narrowest first:
   *
   *  1. what this request says (the composer's toggle),
   *  2. what the conversation last chose (`assistant_threads.web_search`),
   *  3. the user's default (`assistant_settings.web_search_default`).
   *
   * Then the deployment's own switch and a configured backend are applied on
   * top. A client cannot turn search on when the operator turned it off or
   * when no provider exists — the boolean is a preference, not a capability.
   */
  const appSettings = await getSettings();
  const searchConfig = await loadSearchConfig(appSettings);
  const requestedWebSearch =
    body.webSearch === true ? true : body.webSearch === false ? false : null;

  /**
   * A model is required, on both paths, and there is no fallback. Checked
   * before the credential, because it is a read of the row already in hand and
   * because it is the thing a person can fix in the panel they are looking at.
   */
  if (!config.ready) {
    const message = translate(
      locale,
      config.missing === "no-upstream"
        ? "assistant.error.noUpstream"
        : config.missing === "no-key"
          ? "assistant.error.noKey"
          : config.mode === "account"
            ? "assistant.error.noAccountModel"
            : "assistant.error.noModel",
    );
    return Response.json(
      { ok: false, error: { code: "not_configured", message } },
      { status: 409 },
    );
  }

  const credential = await resolveToolCredential({
    userId: me.id,
    mode: config.mode,
    ...(relayKey ? { relayKey } : {}),
  });

  /**
   * "Neither" is fatal on the account path, and only there.
   *
   * It arrives when somebody chose the account path without having created and
   * switched on an account credential — which the assistant's own form did not
   * mention, because the form is not the place that switch lives. Falling
   * through treated it as the key path, so the turn went out with no model and
   * the only configuration that worked was somebody else's key. It is refused
   * here, and the refusal names the switch rather than a key: the account path
   * needs no secret at any point, and saying "key" there is what sent people
   * looking for one.
   *
   * **On the key path it is not an error.** That turn spends the caller's own
   * stored upstream key and never touches a relay key, so "neither" only means
   * the *tools* have nothing to spend — which they already report themselves.
   * Refusing the turn there would have made an attachment or a plain message
   * fail because an unrelated switch was off.
   */
  if (config.mode === "account" && credential.kind === "none") {
    return Response.json(
      {
        ok: false,
        error: {
          code: "no_credential",
          message: translate(
            locale,
            credential.reason === "switch_off"
              ? "assistant.error.credentialOff"
              : "assistant.error.credentialMissing",
          ),
        },
      },
      { status: 409 },
    );
  }

  const onAccount = credential.kind === "account";
  const settings = onAccount ? null : stored;

  /**
   * The model the account path asks for, checked against what that credential
   * may actually call.
   *
   * Validated rather than trusted because the list is a policy decision — the
   * account owner's whitelist, the key's own whitelist, and which providers
   * are enabled — and a request body is not where that is enforced. A model
   * outside it would otherwise be a way to spend against something the user
   * was not offered. A stored model that has since been withdrawn from that
   * list is a configuration to fix, said as such, rather than silently
   * replaced by one they did not pick.
   */
  if (onAccount) {
    const allowed = await listClientModelIds(credential.account.apiKey, credential.account.user);
    if (!allowed.includes(config.model)) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "model_not_allowed",
            // Two reasons lead to the same refusal, so the message has to
            // cover both: the model may be gone from the deployment, or the
            // account may not be allowed to use it. Only the first is "your
            // setting is stale" — telling somebody that a model which is
            // right there on the provider list "is no longer available" is
            // telling them the wrong thing about somebody else's allocation.
            message: allowed.length
              ? translate(locale, "assistant.error.modelNotAllowed", { model: config.model })
              : translate(locale, "assistant.error.noModels"),
          },
        },
        { status: 400 },
      );
    }
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  let thread = threadId
    ? await getAssistantThread(me.id, threadId)
    : await createAssistantThread(
        me.id,
        message.slice(0, 60) || firstUploadTitle(uploads.files, locale),
        // Only an explicit choice is stored; null keeps inheriting the user's
        // default, so changing that default still affects untouched threads.
        requestedWebSearch,
      );
  if (!thread) {
    return Response.json(
      {
        ok: false,
        error: { code: "not_found", message: translate(locale, "assistant.error.threadNotFound") },
      },
      { status: 404 },
    );
  }

  // Keep the conversation's stored choice in step with what this turn used.
  if (threadId && requestedWebSearch !== null && thread.webSearch !== requestedWebSearch) {
    const updated = await setAssistantThreadWebSearch(me.id, thread.id, requestedWebSearch);
    if (updated) thread = updated;
  }

  const webSearchChoice =
    requestedWebSearch ?? thread.webSearch ?? stored?.webSearchDefault ?? true;
  /**
   * Why this turn may not search — or that it may.
   *
   * Three reasons, in the order a reader would ask them: the user switched it
   * off for this conversation, the administrator switched the feature off for
   * the deployment, or there is no backend to search with at all.
   *
   * **The user's own search service counts as a backend.** It is theirs, it is
   * the one the assistant uses when they have one, and a user who configured
   * it should not be told the deployment has no search.
   *
   * The administrator's switch still governs: the deployment's search being
   * off is a statement about the deployment, and it is not a user's to
   * overrule.
   *
   * **The account identity is the tool's business, not this one's.** The
   * deployment's providers need the assistant credential, and the tool answers
   * with that reason. Deciding it here would remove the tool from the
   * definitions, and a model that cannot see the tool cannot tell the user
   * what is missing — it can only report that search is off, which is a
   * different (and wrong) thing to say.
   */
  const hasOwnBackend = useOwnSearchService(stored);
  const webSearchDisabledReason = !webSearchChoice
    ? ("user" as const)
    : !searchConfig.enabled
      ? ("admin" as const)
      : !hasOwnBackend && !searchConfig.backendConfigured
        ? ("no_backend" as const)
        : undefined;
  const webSearchEnabled = webSearchDisabledReason === undefined;
  const webSearchLimit = stored?.webSearchLimit ?? DEFAULT_WEB_SEARCH_LIMIT;

  /**
   * Resolved here, while the request context is still live. The tool loop runs
   * inside a stream callback, where `next/headers` may no longer resolve, and
   * without resolving the address before the stream the model tester addressed
   * http://localhost:3000 and failed with "fetch failed" on every self-hosted
   * deployment that does not set RELAY_PUBLIC_URL. The documentation tool and
   * its language have to come from here for the same reason.
   */
  const gatewayBase = await resolvePublicUrl();
  // Already loaded above for the search settings; a second read would be the
  // same row twice in one request.
  const docPages = appSettings.docPages ?? [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      /**
       * A keep-alive, because something between here and the browser has its own
       * read timeout and the turn is allowed to outlast it.
       *
       * `MAX_TURN_MS` is 30 minutes, and the proxy in front of this app is
       * configured with a read timeout of its own — a fraction of that. nginx's
       * `proxy_read_timeout` measures the gap *between* reads, so a turn that is
       * streaming is never at risk, but a slow model call or a long tool call
       * can go minutes without emitting a byte, and that gap is what gets the
       * connection cut. The turn then stops with nothing on screen explaining
       * why, and nothing in this process having decided to stop it.
       *
       * An SSE comment line is the cheapest way to hold the socket: the client
       * parser drops anything that is not a `data:` frame, so this is invisible
       * to the UI and costs a few bytes on the wire. 25s is well under nginx's
       * 60s default as well as the 600s this deployment sets, so it does not
       * depend on which one is in effect.
       */
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // The stream closed underneath us; `finally` clears the interval.
        }
      }, KEEPALIVE_MS);

      try {
        // Stored here rather than in the route body so a write failure is a
        // result the model can be told about, next to everything else that can
        // go wrong mid-turn — not an exception that ends the stream.
        const attachments: MessageAttachment[] = [];
        for (const file of uploads.files) {
          try {
            const saved = await saveAssistantArtifact({
              userId: me.id,
              threadId: thread.id,
              kind: file.kind,
              bytes: file.bytes,
              contentType: file.contentType,
            });
            attachments.push({ ...artifactRef(saved), name: file.name });
          } catch {
            // Drop this one, keep the rest: an unwritable blob should not cost
            // the user the file they did manage to attach.
          }
        }

        await runChat({
          user: me,
          // Exactly one of the two is passed, so `runChat` cannot pick the wrong
          // vendor: the stored upstream when there is one, the in-process proxy
          // when the account credential is paying.
          ...(settings ? { settings } : {}),
          // The parameters on the account path too. They belong to the model the
          // person chose, and the account path's models are this deployment's
          // own — so the form fills those in from the catalogue, and the values
          // still belong to them rather than to the provider that answers.
          ...(onAccount ? { modelParams: config.params } : {}),
          ...(onAccount
            ? {
                inProcessUpstream: {
                  model: config.model,
                  transport: accountTransport(credential.account, locale),
                },
              }
            : {}),
          thread,
          message,
          attachments,
          locale,
          docPages,
          credential,
          gatewayBase,
          webSearchEnabled,
          ...(webSearchDisabledReason ? { webSearchDisabledReason } : {}),
          webSearchLimit,
          signal: req.signal,
          emit: send,
        });
      } catch (err) {
        send({ type: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(keepAlive);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // A first message creates the thread, and the client has no other way to
      // learn its id before the stream ends.
      "X-Assistant-Thread": thread.id,
    },
  });
}
