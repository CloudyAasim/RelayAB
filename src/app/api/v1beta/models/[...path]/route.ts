/**
 * app/api/v1beta/models/[...path]/route.ts
 *
 * The Gemini `generateContent` surface, exposed publicly as
 * `POST /v1beta/models/{model}:generateContent` and
 * `POST /v1beta/models/{model}:streamGenerateContent`.
 *
 * The path carries the model and the method, and the body carries neither —
 * which is Gemini's shape and the reason the model has to be put back into
 * the request before it reaches the proxy.
 *
 * Auth: the Google carriers (`x-goog-api-key`, `?key=`) as well as the
 * OpenAI-shaped ones. See `resolveAuthHeader`.
 */
import { authenticateBearer, reasonToHttp, resolveAuthHeader } from "@/lib/auth/apikey";
import { proxyError } from "@/lib/proxy/errors";
import { parseGeminiPath, proxyGeminiGenerate } from "@/lib/proxy/gemini";
import type { ApiKey } from "@/lib/db/types";
import { getUserById as lookupUserById } from "@/lib/db/users";
import type { GeminiGenerateRequest } from "@/lib/protocol/gemini";

export const runtime = "nodejs";
// A Gemini stream can run for minutes on a thinking model, and a truncated
// SSE loses the frame the usage rides on — which means the call is never
// billed.
export const maxDuration = 300;

export async function POST(
  req: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const parsed = parseGeminiPath((path ?? []).join("/"));
  if (!parsed) {
    return proxyError(
      404,
      "not_found",
      "Unknown Gemini path. This surface answers :generateContent and :streamGenerateContent.",
    );
  }
  const { model, method } = parsed;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    requestedModel: model,
  });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return proxyError(http.status, http.code, http.message);
  }

  const owner = auth.user ?? (await lookupUserById(auth.key.userId));
  if (!owner) {
    return proxyError(
      403,
      "user_not_found",
      "The account owning this key no longer exists",
    );
  }

  const result = await proxyGeminiGenerate({
    body: (body ?? {}) as GeminiGenerateRequest,
    model,
    stream: method === "streamGenerateContent",
    apiKey: auth.key as ApiKey,
    user: owner,
    signal: req.signal,
  });

  if (!result.ok) {
    return proxyError(
      result.status,
      result.error?.code ?? "server_error",
      result.error?.message ?? "",
    );
  }

  if (result.body) {
    return new Response(result.body, {
      status: 200,
      headers: {
        "Content-Type": result.contentType ?? "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return Response.json(result.data, { status: result.status });
}
