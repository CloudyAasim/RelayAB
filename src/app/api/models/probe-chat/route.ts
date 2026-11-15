/**
 * app/api/models/probe-chat/route.ts
 *
 *   POST /api/models/probe-chat
 *   Body: { baseUrl, apiKey, model, prompt?, parameters?, path?, stream?, extraHeaders? }
 *
 * Test an arbitrary OpenAI-compatible chat endpoint **with the same shape the
 * real call has**, including streaming. The older `/api/models/probe` always
 * asked for `stream: false` and took no parameters, so the thing it tested was
 * not the thing a client sends — a parameter the vendor rejects, or a stream
 * that never deltas, could not be seen from this page.
 *
 * The key is never stored: it lives in the request body, goes into the outbound
 * fetch, and is dropped when the handler returns.
 *
 * Only `http(s)` is accepted; that is the same rule the older probe follows, and
 * a self-hosted deployment legitimately tests providers on its own network.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  baseUrl: z.string().min(1, "请填写 API 地址").max(500),
  apiKey: z.string().min(1, "请填写 API 密钥").max(500),
  model: z.string().min(1, "请填写模型名").max(200),
  prompt: z.string().max(20000).optional(),
  /** The endpoint path under the base URL, when the vendor does not use /chat/completions. */
  path: z.string().max(300).optional(),
  stream: z.boolean().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

function endpointFor(baseUrl: string, path?: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path?.trim() || "/chat/completions";
  return `${base}${suffix.startsWith("/") ? "" : "/"}${suffix}`;
}

function protocolProblem(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : "只支持 http / https";
  } catch {
    return "API 地址不是合法 URL";
  }
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

  const { baseUrl, apiKey, model, prompt, path, stream, parameters, extraHeaders } = parsed.data;
  const endpoint = endpointFor(baseUrl, path);
  const problem = protocolProblem(endpoint);
  if (problem) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_endpoint", message: problem } },
      { status: 400 },
    );
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt?.trim() || "Say PONG" }],
        ...(parameters ?? {}),
        stream: Boolean(stream),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return NextResponse.json({
      ok: true,
      data: {
        endpoint,
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json({
      ok: true,
      data: {
        endpoint,
        ok: false,
        status: res.status,
        latencyMs: Date.now() - started,
        error: text.slice(0, 4000),
      },
    });
  }

  if (!stream) {
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — the caller shows the text */
    }
    return NextResponse.json({
      ok: true,
      data: {
        endpoint,
        ok: true,
        status: res.status,
        latencyMs: Date.now() - started,
        json,
        text: json ? undefined : text.slice(0, 4000),
      },
    });
  }

  if (!res.body) {
    return NextResponse.json({
      ok: true,
      data: {
        endpoint,
        ok: false,
        status: res.status,
        latencyMs: Date.now() - started,
        error: "上游没有返回流",
      },
    });
  }

  // Pass the event stream through unchanged: what the page reads is what the
  // client would read, framing and keep-alives included.
  return new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Probe-Endpoint": encodeURIComponent(endpoint),
    },
  });
}
