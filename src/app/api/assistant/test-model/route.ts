/**
 * app/api/assistant/test-model/route.ts
 *
 *   POST /api/assistant/test-model  → { model, prompt? }
 *
 * The model test page's account path. On the key path the browser calls the
 * gateway itself with a pasted bearer token; there is no such token on the
 * account path — by design there is no plaintext to paste — so the call has to
 * happen here, on the server, against the caller's own credential.
 *
 * The work itself is `proxyChatCompletion`, the same function
 * `/v1/chat/completions` calls, so the result really does answer "does this
 * model work" rather than "did a different code path work".
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import { consumeAssistantTurn } from "@/lib/assistant/rate-limit";
import { proxyChatCompletion } from "@/lib/proxy/openai";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  model: z.string().min(1).max(200),
  prompt: z.string().max(2000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  // Shares the assistant's budget on purpose: a test is a real call against a
  // real quota, and leaving it unmetered would be a hole straight past the
  // limiter that protects the chat endpoint.
  const rate = consumeAssistantTurn(me.id);
  if (rate.limited) {
    return NextResponse.json(
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "model 不能为空" } },
      { status: 400 },
    );
  }

  // Key mode is deliberately not accepted here. The page sends the browser-side
  // request itself in that mode, so answering it here would be a second way to
  // spend a credential with different rules.
  const credential = await resolveToolCredential({ userId: me.id, mode: "account" });
  if (credential.kind !== "account") {
    // `mode: "account"` with no pasted key can only come back as `none`, but
    // the union is checked rather than assumed so a future change cannot turn
    // a wrong-credential case into a crash here.
    const reason = credential.kind === "none" ? credential.reason : "no_credential";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "no_credential",
          message:
            reason === "switch_off"
              ? "助手凭据已创建但没有开启。请在助手设置里打开开关，或改用「自己配置的密钥」。"
              : "还没有开启助手凭据。请先在助手设置里创建并开启，或改用「自己配置的密钥」。",
        },
      },
      { status: 409 },
    );
  }

  const started = Date.now();
  const result = await proxyChatCompletion({
    req: {
      model: parsed.data.model,
      messages: [
        {
          role: "user",
          content:
            parsed.data.prompt && parsed.data.prompt.trim()
              ? parsed.data.prompt
              : "用一句话介绍你自己。",
        },
      ],
      max_tokens: 200,
      stream: false,
    },
    apiKey: credential.account.apiKey,
    user: credential.account.user,
    signal: AbortSignal.timeout(90_000),
  });
  const latencyMs = Date.now() - started;

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: result.error?.code ?? "upstream_error", message: result.error?.message ?? "上游调用失败" },
        data: { httpStatus: result.status, latencyMs },
      },
      { status: result.status >= 400 ? result.status : 502 },
    );
  }

  const data = result.data as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { total_tokens?: number };
  };
  return NextResponse.json({
    ok: true,
    data: {
      via: "account",
      httpStatus: result.status,
      latencyMs,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
      answer: (data.choices?.[0]?.message?.content ?? "").slice(0, 4000),
    },
  });
}
