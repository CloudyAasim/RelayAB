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

export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 8000;

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

  let body: { message?: unknown; threadId?: unknown; relayKey?: unknown; credentialMode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
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
    : await createAssistantThread(me.id, message.slice(0, 60));
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
  const [gatewayBase, credential] = await Promise.all([
    resolvePublicUrl(),
    resolveToolCredential({ userId: me.id, mode: credentialMode, relayKey }),
  ]);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatEvent): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await runChat({
          user: me,
          settings,
          thread,
          message,
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
