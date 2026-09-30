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
  if (binary) {
    return new Response(binary.stream ?? binary.body, {
      status: 200,
      headers: { "content-type": binary.contentType ?? "audio/mpeg" },
    });
  }

  // No byte stream: a JSON-shaped vendor. If the spec mapped the audio to a
  // base64 item (MiniMax hex, or any vendor's base64), hand those bytes back —
  // that is the shape this endpoint promises.
  const encoded = outcome.value.result.items.find((item) => item.kind === "base64");
  if (encoded) {
    try {
      const binaryString = atob(encoded.value);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": audioMimeType(input.responseFormat) },
      });
    } catch {
      return mediaErrorResponse({
        status: 502,
        code: "no_audio",
        message: "upstream returned audio that is not decodable base64",
      });
    }
  }

  return mediaErrorResponse({
    status: 502,
    code: "no_audio",
    message:
      "upstream returned no audio — a JSON vendor must map its audio to a base64 item " +
      '(e.g. {"kind":"base64","encoding":"hex","value":"$.data.audio"})',
  });
}

/** Content type for a JSON-shaped vendor's audio, from the requested format. */
function audioMimeType(format: string | undefined): string {
  const table: Record<string, string> = {
    mp3: "audio/mpeg",
    mpeg: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    aac: "audio/aac",
    pcm: "application/octet-stream",
  };
  return (format && table[format]) || "audio/mpeg";
}
