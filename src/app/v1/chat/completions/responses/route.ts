/**
 * app/v1/chat/completions/responses/route.ts
 *
 * OpenAI Responses API compatible endpoint at /v1/chat/completions/responses.
 * This allows clients configured with base_url + "/responses" to work correctly
 * when the base_url is set to the chat completions endpoint.
 *
 * This is an alias for the canonical /v1/responses handler: protocol
 * conversion for Chat/Anthropic-only providers now lives in
 * `proxyOpenAIResponse`, so both paths behave identically.
 */
import { NextResponse } from "next/server";
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyOpenAIResponse } from "@/lib/proxy/openai";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";
// See api/v1/responses: long streams must not be cut off at 60s.
export const maxDuration = 300;

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

  const responseReq = body as Parameters<typeof proxyOpenAIResponse>[0]["req"];

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

  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "The account owning this key no longer exists" } },
      { status: 403 },
    );
  }

  let result;
  try {
    result = await proxyOpenAIResponse({
      req: responseReq,
      apiKey: auth.key as ApiKey,
      user: owner,
    });
  } catch (err) {
    console.error("[v1/chat/completions/responses] proxyOpenAIResponse threw:", err);
    return NextResponse.json(
      { ok: false, error: { code: "proxy_error", message: String(err) } },
      { status: 500 },
    );
  }

  // Streaming clients must receive an SSE body. Providers reached through the
  // chat conversion hop answer with a buffered `response` object, which
  // `proxyResultToResponse` replays as `response.*` events.
  const requestedStream =
    typeof body === "object" && body !== null && "stream" in body &&
    Boolean((body as Record<string, unknown>).stream);
  return proxyResultToResponse(result, { streamRequest: requestedStream });
}
