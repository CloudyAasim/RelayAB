/**
 * app/api/v1/audio/speech/route.ts
 *
 * Text-to-speech, exposed publicly as `POST /v1/audio/speech`
 * (OpenAI-compatible JSON in, audio bytes out).
 *
 * The spec's `responseMode` decides what happens to the upstream body:
 * `binary` buffers it, `stream` pipes it through untouched. Either way the
 * bytes are returned verbatim — an audio file must never be JSON-parsed.
 *
 * Some vendors have no byte-stream mode at all: MiniMax's `t2a_v2` answers JSON
 * whose `data.audio` holds hex (its default) or a URL. A spec expresses that with
 * a `base64` item (`encoding: "hex"`), and this route decodes it — otherwise the
 * endpoint could only ever serve vendors that stream bytes, and every such call
 * would fail with `no_audio` after the engine had already succeeded.
 */
import {
  audioDelivery,
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

  const delivery = audioDelivery(outcome.value.result, input.responseFormat);
  if (!delivery) {
    // The handler already refuses (and does not charge) such a result, so this is
    // only reachable if the contract check and this read ever disagree.
    return mediaErrorResponse({
      status: 502,
      code: "no_audio",
      message: "upstream returned no audio",
    });
  }
  if (delivery.kind === "stream") {
    return new Response(delivery.stream, {
      status: 200,
      headers: { "content-type": delivery.contentType },
    });
  }
  return new Response(delivery.bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": delivery.contentType },
  });
}
