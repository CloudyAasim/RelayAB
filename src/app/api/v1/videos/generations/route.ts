/**
 * app/api/v1/videos/generations/route.ts
 *
 * Video generation, exposed publicly as `POST /v1/videos/generations`.
 *
 * Vendors that answer asynchronously are handled entirely by the engine: the
 * spec declares `async`, and the engine submits, polls and only then settles.
 * The client still gets one synchronous response.
 */
import {
  authorizeMediaRequest,
  executeMediaRequest,
  mediaErrorResponse,
  mediaItemsResponse,
  requirePrompt,
  type MediaRequestInput,
} from "@/lib/media/handler";
import { proxyError, quotaHeaders } from "@/lib/proxy/errors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return proxyError(400, "bad_json", "Invalid JSON body");
  }

  const model = typeof body.model === "string" ? body.model : "";
  const auth = await authorizeMediaRequest(req, model);
  if (!auth.ok) return auth.response;

  const input: MediaRequestInput = {
    model,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    ...(typeof body.n === "number" ? { n: body.n } : {}),
    ...(typeof body.size === "string" ? { size: body.size } : {}),
    ...(typeof body.seed === "number" ? { seed: body.seed } : {}),
    extra: body,
  };

  const invalid = requirePrompt(input.prompt, 4000);
  if (invalid) return mediaErrorResponse(invalid);

  const outcome = await executeMediaRequest({
    capability: "video.generate",
    input,
    apiKey: auth.key,
    user: auth.user,
    signal: req.signal,
  });
  if (!outcome.ok) return mediaErrorResponse(outcome.error);

  const { result } = outcome.value;
  if (result.items.length === 0) {
    return mediaErrorResponse({
      status: 502,
      code: "no_media",
      message: "upstream returned no video",
    });
  }
  return Response.json(mediaItemsResponse(result.items, result.taskId), {
    headers: quotaHeaders(auth.user),
  });
}
