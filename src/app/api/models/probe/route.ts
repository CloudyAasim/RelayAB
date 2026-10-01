/**
 * app/api/models/probe/route.ts
 *
 *   POST /api/models/probe
 *   Body: { baseUrl, apiKey, model?, prompt?, mode?: "list" | "chat" }
 *
 * Test an arbitrary OpenAI-compatible endpoint with a key the browser supplies
 * for this one call.
 *
 * **The key is never written anywhere.** It is not stored in the database, not
 * logged, and not echoed back — it lives in the request body and in the
 * outbound fetch, and is dropped when the handler returns. That is the whole
 * point of this endpoint: someone can check whether a vendor's key works
 * without handing the server a copy to keep. The assistant's own settings
 * (`/api/assistant/settings`) are the separate case where a key *is* stored,
 * encrypted, because the assistant has to call it again on later turns.
 *
 * Anyone signed in may use it; it never reads or writes RelayAB's own data.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { probeUpstream } from "@/lib/assistant/client";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  baseUrl: z.string().min(1, "请填写 API 地址").max(500),
  apiKey: z.string().min(1, "请填写 API 密钥").max(500),
  model: z.string().max(200).optional(),
  prompt: z.string().max(4000).optional(),
  mode: z.enum(["list", "chat"]).default("list"),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  const { baseUrl, apiKey, model, prompt, mode, extraHeaders } = parsed.data;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(extraHeaders ?? {}),
  };

  if (mode === "chat") {
    if (!model) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: "要测试对话，请先填写模型名" } },
        { status: 400 },
      );
    }
    const started = Date.now();
    try {
      const res = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: prompt?.trim() || "用一句话介绍你自己。",
            },
          ],
          max_tokens: 256,
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const latencyMs = Date.now() - started;
      const text = await res.text();

      if (!res.ok) {
        return NextResponse.json({
          ok: true,
          data: {
            mode,
            ok: false,
            httpStatus: res.status,
            latencyMs,
            response: text.slice(0, 2000),
          },
        });
      }

      let answer = "";
      let finishReason: string | null = null;
      let totalTokens: number | null = null;
      try {
        const parsedBody = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: { total_tokens?: number };
        };
        answer = parsedBody.choices?.[0]?.message?.content ?? "";
        finishReason = parsedBody.choices?.[0]?.finish_reason ?? null;
        totalTokens = parsedBody.usage?.total_tokens ?? null;
      } catch {
        answer = text.slice(0, 2000);
      }

      return NextResponse.json({
        ok: true,
        data: { mode, ok: true, httpStatus: res.status, latencyMs, finishReason, totalTokens, answer },
      });
    } catch (err) {
      return NextResponse.json({
        ok: true,
        data: {
          mode,
          ok: false,
          httpStatus: 0,
          latencyMs: Date.now() - started,
          response: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  const probe = await probeUpstream({
    baseUrl,
    apiKey,
    ...(extraHeaders ? { extraHeaders } : {}),
  });
  return NextResponse.json({ ok: true, data: { mode, ...probe } });
}
