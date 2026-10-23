/**
 * app/api/v1/chat/completions/route.ts
 *
 * OpenAI Chat Completions compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, messages, stream?, ... }
 *
 * Flow: parse Bearer → look up key → validate → forward → record usage.
 */
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import { validateChatBody } from "@/lib/proxy/validate";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";
// Long generations must not be cut off at 60s.
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  // 1. Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  // 2. Authenticate.
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

  // The owner record carries the quota pool and the model whitelist, so the
  // proxy cannot validate or charge without it.
  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  // 3. Shape check — after auth, before the upstream round trip.
  //
  // Auth deliberately goes first: a bad key is a bad key whatever the body
  // says, and an unauthenticated caller has no business learning whether their
  // JSON was well formed.
  const shapeError = validateChatBody(body);
  if (shapeError) {
    return proxyError(shapeError.status, shapeError.code, shapeError.message);
  }

  // 4. Forward.
  const requestedStream =
    typeof body === "object" && body !== null && "stream" in body &&
    Boolean((body as Record<string, unknown>).stream);
  const result = await proxyChatCompletion({
    req: body as Parameters<typeof proxyChatCompletion>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    // Let a client disconnect settle the usage row instead of dropping it.
    signal: req.signal,
  });

  if (!result.ok) {
    return proxyError(result.status, result.error!.code, result.error!.message);
  }
  return proxyResultToResponse(result, { streamRequest: requestedStream, quota: owner });
}
