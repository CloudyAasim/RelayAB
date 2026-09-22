/**
 * src/lib/proxy/respond.ts
 *
 * Turn a `ProxyResult` into an HTTP `Response`.
 *
 * Buffered results are serialized as JSON. When the proxy hands back a `body`
 * (SSE passthrough) the stream is forwarded as-is, with headers that stop
 * intermediate proxies from buffering it — Codex CLI and the OpenAI SDK rely
 * on receiving `text/event-stream` incrementally.
 */
import { NextResponse } from "next/server";
import type { ProxyResult } from "./openai";

export function proxyResultToResponse(result: ProxyResult): Response {
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  if (result.body) {
    return new Response(result.body, {
      status: result.status,
      headers: {
        "Content-Type": result.contentType ?? "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return NextResponse.json(result.data, { status: result.status });
}
