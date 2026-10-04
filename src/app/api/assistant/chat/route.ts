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
import { createAssistantThread, getAssistantThread } from "@/lib/db/assistant";
import { runChat, type ChatEvent } from "@/lib/assistant/chat";
import { resolveAssistantConfig } from "@/lib/assistant/config";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { UpstreamError } from "@/lib/assistant/client";
import { proxyChatCompletion, type ChatCompletionRequest } from "@/lib/proxy/openai";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import { listClientModelIds } from "@/lib/proxy/model-catalog";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import { resolvePublicUrl } from "@/lib/public-url";
import { getServerLocale } from "@/lib/i18n/server";
import { getSettings } from "@/lib/db/settings";
import { saveAssistantArtifact, artifactRef } from "@/lib/db/assistant-artifacts";
import type { MessageAttachment } from "@/lib/assistant/schema";

export const dynamic = "force-dynamic";

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
function accountTransport(account: {
  apiKey: import("@/lib/db/types").ApiKey;
  user: import("@/lib/db/types").User;
}): import("@/lib/assistant/client").UpstreamTransport {
  return async ({ body, signal }) => {
    const req = body as ChatCompletionRequest;
    const result = await proxyChatCompletion({ req, apiKey: account.apiKey, user: account.user, signal });
    const res = proxyResultToResponse(result, { streamRequest: true });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(text.slice(0, 400) || `上游返回 ${res.status}`, res.status, text);
    }
    if (!res.body) {
      throw new UpstreamError("上游没有返回可读的响应流", 502);
    }
    return res.body;
  };
}

const MAX_MESSAGE_CHARS = 8000;

/** One file, one ceiling. Matches the media transcriptions route's 25 MB. */
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
function readAttachments(value: unknown): { files: UploadedFile[] } | { error: Response } {
  if (value === undefined || value === null) return { files: [] };
  if (!Array.isArray(value)) return { error: badRequest("bad_request", "attachments 必须是数组") };
  if (value.length > MAX_ATTACHMENTS) {
    return { error: badRequest("too_many_attachments", `一次最多上传 ${MAX_ATTACHMENTS} 个文件`) };
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
          `${name} 没有加上：不支持 ${contentType || "未知类型"}，只支持图片、音频和视频。`,
        ),
      };
    }
    if (typeof row.data !== "string" || !row.data) {
      return { error: badRequest("bad_request", `${name} 没有内容`) };
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(row.data, "base64"));
    } catch {
      return { error: badRequest("bad_request", `${name} 不是合法的 base64`) };
    }
    if (bytes.byteLength === 0) {
      return { error: badRequest("bad_request", `${name} 是空文件`) };
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { error: badRequest("attachment_too_large", `${name} 超过 25MB 上限`) };
    }
    files.push({ name, contentType, kind, bytes });
  }
  return { files };
}

/** A thread opened by nothing but a file still needs a name a person can find. */
function firstUploadTitle(files: UploadedFile[]): string {
  const first = files[0];
  if (!first) return "新对话";
  return files.length > 1 ? `${first.name} 等 ${files.length} 个文件` : first.name.slice(0, 60);
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return Response.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

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
          message: `助手请求太频繁了，${rate.retryAfterSeconds} 秒后再试。`,
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
  const uploads = readAttachments(body.attachments);
  if ("error" in uploads) return uploads.error;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  // A turn of nothing but a picture is a normal thing to send, so it is
  // allowed — but only with files. An empty turn with nothing attached is a
  // mistake, and starting a thread for it would leave a question mark in the
  // user's history.
  if (!message && uploads.files.length === 0) {
    return Response.json(
      { ok: false, error: { code: "bad_request", message: "消息不能为空" } },
      { status: 400 },
    );
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return Response.json(
      { ok: false, error: { code: "too_long", message: `消息过长（上限 ${MAX_MESSAGE_CHARS} 字）` } },
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
   * A model is required, on both paths, and there is no fallback. Checked
   * before the credential, because it is a read of the row already in hand and
   * because it is the thing a person can fix in the panel they are looking at.
   */
  if (!config.ready) {
    const message =
      config.missing === "no-upstream"
        ? "还没有填写接口地址。请到助手设置里补上。"
        : config.missing === "no-key"
          ? "还没有配置密钥。请到助手设置里补上。"
          : config.mode === "account"
            ? "还没有选模型。请到助手设置里选一个模型。"
            : "还没有填写模型名。请到助手设置里补上。";
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
          message:
            credential.reason === "switch_off"
              ? "「用我的账号身份」已关闭。请到设置里打开，或改用「用我自己配置的密钥」。"
              : "还没有开启「用我的账号身份」。请到设置里创建并打开它，或者改用「用我自己配置的密钥」。",
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
   * key's own whitelist and which providers are enabled — and a request body is
   * not where that is enforced. A model outside it would otherwise be a way to
   * spend against something the user was not offered. A stored model that has
   * since been withdrawn from that list is a configuration to fix, said as
   * such, rather than silently replaced by one they did not pick.
   */
  if (onAccount) {
    const allowed = await listClientModelIds(credential.account.apiKey);
    if (!allowed.includes(config.model)) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "model_not_allowed",
            message: allowed.length
              ? `你选的模型现在不可用了：${config.model}。请到助手设置里换一个。`
              : "当前没有可用模型，请先让管理员配置提供商。",
          },
        },
        { status: 400 },
      );
    }
  }

  const threadId = typeof body.threadId === "string" ? body.threadId : null;
  const thread = threadId
    ? await getAssistantThread(me.id, threadId)
    : await createAssistantThread(me.id, message.slice(0, 60) || firstUploadTitle(uploads.files));
  if (!thread) {
    return Response.json(
      { ok: false, error: { code: "not_found", message: "对话不存在" } },
      { status: 404 },
    );
  }

  /**
   * Resolved here, while the request context is still live. The tool loop runs
   * inside a stream callback, where `next/headers` may no longer resolve, and
   * without resolving the address before the stream the model tester addressed
   * http://localhost:3000 and failed with "fetch failed" on every self-hosted
   * deployment that does not set RELAY_PUBLIC_URL. The documentation tool and
   * its language have to come from here for the same reason.
   */
  const [gatewayBase, locale, docPages] = await Promise.all([
    resolvePublicUrl(),
    getServerLocale(),
    getSettings().then((s) => s.docPages ?? []),
  ]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

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
                  transport: accountTransport(credential.account),
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
          signal: req.signal,
          emit: send,
        });
      } catch (err) {
        send({ type: "error", text: err instanceof Error ? err.message : String(err) });
      } finally {
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
