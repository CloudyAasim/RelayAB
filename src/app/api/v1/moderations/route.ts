/**
 * app/api/v1/moderations/route.ts
 *
 * OpenAI Moderations API compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, input } — a string or an array of strings.
 *
 * Flow: parse Bearer → look up key → validate → forward → record usage.
 *
 * A moderation call has no stream and no output tokens: the vendor returns a
 * verdict per input, and no usage at all — so the prompt's tokens are
 * estimated, the same way a stream that ends without a usage frame is billed.
 */
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { proxyModerations, validateModerationsBody } from "@/lib/proxy/moderations";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";

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

  // 3. Shape check - after auth, before the upstream round trip.
  const shape = validateModerationsBody(body);
  if (!shape.ok) {
    return proxyError(400, "invalid_request_error", shape.message);
  }

  // 4. Get owner
  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  // 5. Forward
  const result = await proxyModerations({
    req: body as Parameters<typeof proxyModerations>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    signal: req.signal,
  });

  if (!result.ok) {
    return proxyError(result.status, result.error?.code ?? "server_error", result.error?.message ?? "");
  }
  return proxyResultToResponse(result, { quota: owner });
}
