/**
 * app/api/v1/responses/route.ts
 *
 * OpenAI Responses API compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, input, tools?, stream? }
 *
 * Flow: parse Bearer → look up key → validate → forward → record usage.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyOpenAIResponse } from "@/lib/proxy/openai";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";
// Streaming turns can legitimately run for minutes (Codex agent loops, long
// reasoning). 60s truncated the SSE mid-flight and, worse, the dropped
// `response.completed` frame meant usage was never billed.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  // 1. Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  // 2. Authenticate
  const requestedModel =
    typeof body === "object" && body !== null && "model" in body
      ? String((body as Record<string, unknown>).model ?? "")
      : "";
  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    requestedModel,
  });

  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return NextResponse.json(
      { ok: false, error: { code: http.code, message: http.message } },
      { status: http.status },
    );
  }

  // 3. Get owner
  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "The account owning this key no longer exists" } },
      { status: 403 },
    );
  }

  // 4. Forward to proxy
  const result = await proxyOpenAIResponse({
    req: body as Parameters<typeof proxyOpenAIResponse>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    // Let a client disconnect settle the usage row instead of dropping it.
    signal: req.signal,
  });

  return proxyResultToResponse(result);
}
