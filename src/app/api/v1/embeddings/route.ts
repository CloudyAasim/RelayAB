/**
 * app/api/v1/embeddings/route.ts
 *
 * OpenAI Embeddings API compatible endpoint.
 *
 * Auth: Bearer sk-relay-...
 * Body: { model, input, encoding_format?, dimensions? }
 *
 * Flow: parse Bearer → look up key → validate → forward → record usage.
 */
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { proxyEmbeddings, validateEmbeddingsBody } from "@/lib/proxy/embeddings";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

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

  // Shape check - after auth, before the upstream round trip. Auth first: a bad
  // key is a bad key whatever the body says.
  const shape = validateEmbeddingsBody(body);
  if (!shape.ok) {
    return proxyError(400, "invalid_request_error", shape.message);
  }

  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  const result = await proxyEmbeddings({
    req: body as Parameters<typeof proxyEmbeddings>[0]["req"],
    apiKey: auth.key as ApiKey,
    user: owner,
    signal: req.signal,
  });

  if (!result.ok) {
    return proxyError(result.status, result.error?.code ?? "server_error", result.error?.message ?? "");
  }
  return proxyResultToResponse(result, { quota: owner });
}
