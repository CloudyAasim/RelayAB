/**
 * app/api/v1/audio/speech/route.ts
 *
 * Text-to-speech, exposed publicly as `POST /v1/audio/speech`
 * (OpenAI-compatible JSON in, audio bytes out).
 *
 * The spec's `responseMode` decides what happens to the upstream body:
 * `binary` buffers it, `stream` pipes it through untouched. Either way the
 * bytes are returned verbatim — an audio file must never be JSON-parsed.
 */
import {
  authorizeMediaRequest,
  executeMediaRequest,
  mediaErrorResponse,
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

  const text = typeof body.input === "string" ? body.input : "";
  if (!text.trim()) {
    return mediaErrorResponse({
      status: 400,
      code: "invalid_request",
      message: "input is required",
    });
  }

  const input: MediaRequestInput = {
    model,
    input: text,
    ...(typeof body.voice === "string" ? { voice: body.voice } : {}),
    ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
    ...(typeof body.response_format === "string"
      ? { responseFormat: body.response_format }
      : {}),
    extra: body,
  };

  const outcome = await executeMediaRequest({
    capability: "audio.tts",
    input,
    apiKey: auth.key,
    user: auth.user,
    signal: req.signal,
  });
  if (!outcome.ok) return mediaErrorResponse(outcome.error);

  const binary = outcome.value.result.binary;
  if (!binary) {
    return mediaErrorResponse({
      status: 502,
      code: "no_audio",
      message: "upstream returned no audio",
    });
  }
  return new Response(binary.stream ?? binary.body, {
    status: 200,
    headers: { "content-type": binary.contentType ?? "audio/mpeg" },
  });
}
