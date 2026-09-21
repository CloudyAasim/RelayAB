/**
 * app/api/anthropic/v1/messages/route.ts
 *
 * Anthropic Messages API compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, messages, max_tokens, ... }
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp } from "@/lib/auth/apikey";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";
import type { ApiKey } from "@/lib/db/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const requestedModel =
    typeof body === "object" && body !== null && "model" in body
      ? String((body as Record<string, unknown>).model ?? "")
      : "";
  const auth = await authenticateBearer({
    authHeader: req.headers.get("Authorization"),
    requestedModel,
  });

  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return NextResponse.json(
      { ok: false, error: { code: http.code, message: http.message } },
      { status: http.status },
    );
  }

  const result = await proxyAnthropicMessage({
    req: body as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey: auth.key as ApiKey,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data, { status: result.status });
}
