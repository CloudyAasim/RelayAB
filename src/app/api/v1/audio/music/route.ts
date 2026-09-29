/**
 * app/api/v1/audio/music/route.ts
 *
 * Music generation, exposed publicly as `POST /v1/audio/music`.
 * Same engine path as video; the normalized response mirrors OpenAI's
 * images-style envelope so a client can treat every media call the same way.
 */
import {
  authorizeMediaRequest,
  executeMediaRequest,
  mediaErrorResponse,
  mediaItemsResponse,
  requirePrompt,
  type MediaRequestInput,
} from "@/lib/media/handler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const model = typeof body.model === "string" ? body.model : "";
  const auth = await authorizeMediaRequest(req, model);
  if (!auth.ok) return auth.response;

  const input: MediaRequestInput = {
    model,
    prompt: typeof body.prompt === "string" ? body.prompt : "",
    ...(typeof body.n === "number" ? { n: body.n } : {}),
    ...(typeof body.duration === "number" ? { extra: { ...body, duration: body.duration } } : {}),
    extra: body,
  };

  const invalid = requirePrompt(input.prompt, 4000);
  if (invalid) return mediaErrorResponse(invalid);

  const outcome = await executeMediaRequest({
    capability: "music.generate",
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
      message: "upstream returned no audio",
    });
  }
  return Response.json(mediaItemsResponse(result.items, result.taskId));
}
