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
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { proxyOpenAIResponse } from "@/lib/proxy/openai";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import { validateResponsesBody } from "@/lib/proxy/validate";
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
    return proxyError(400, "bad_json", "Invalid JSON body");
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
    return proxyError(http.status, http.code, http.message);
  }

  // 2b. Shape check - after auth, before the upstream round trip. Auth first:
  // a bad key is a bad key whatever the body says.
  const shapeError = validateResponsesBody(body);
  if (shapeError) {
    return proxyError(shapeError.status, shapeError.code, shapeError.message);
  }

  // 3. Get owner
  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  // 4. Forward to proxy
  // Streaming clients (Codex CLI always sets this) must receive an SSE body.
  // Providers reached through the chat conversion hop answer with a buffered
  // `response` object, which `proxyResultToResponse` replays as `response.*`
  // events so the client's stream parser sees frames instead of bare JSON.
  const requestedStream =
    typeof body === "object" && body !== null && "stream" in body &&
    Boolean((body as Record<string, unknown>).stream);
  const result = await proxyOpenAIResponse({
    req: body as Parameters<typeof proxyOpenAIResponse>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    // Let a client disconnect settle the usage row instead of dropping it.
    signal: req.signal,
  });

  return proxyResultToResponse(result, { streamRequest: requestedStream, quota: owner });
}
