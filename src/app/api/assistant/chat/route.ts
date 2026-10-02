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
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import { resolvePublicUrl } from "@/lib/public-url";
import { getServerLocale } from "@/lib/i18n/server";
import { getSettings } from "@/lib/db/settings";
import { saveAssistantArtifact, artifactRef } from "@/lib/db/assistant-artifacts";
import type { MessageAttachment } from "@/lib/assistant/schema";

export const dynamic = "force-dynamic";

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
    credentialMode?: unknown;
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

  const settings = await getAssistantSettings(me.id);
  if (!settings) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "not_configured",
          message: "还没有配置助手的模型。请先在助手设置里填入你自己的 API 地址、密钥和模型名。",
        },
      },
      { status: 409 },
    );
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

  const relayKey = typeof body.relayKey === "string" && body.relayKey.trim()
    ? body.relayKey.trim()
    : undefined;
  const credentialMode =
    body.credentialMode === "account" || body.credentialMode === "key" ? body.credentialMode : undefined;

  // Resolved here, while the request context is still live — it reads the
  // database and, for the key path, the deployment's own address. Doing it in
  // the stream callback would be too late for `next/headers`.
  //
  // The tool loop runs inside a stream callback, where `next/headers` may no
  // longer resolve, and without resolving the address here the model tester
  // addressed http://localhost:3000 and failed with "fetch failed" on every
  // self-hosted deployment that does not set RELAY_PUBLIC_URL.
  const [gatewayBase, credential, locale, docPages] = await Promise.all([
    resolvePublicUrl(),
    resolveToolCredential({ userId: me.id, mode: credentialMode, relayKey }),
    // Also resolved here, for the same reason: the tool loop runs inside a
    // stream callback where `next/headers` no longer resolves, and both the
    // documentation tool and its language have to come from here.
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
          settings,
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
