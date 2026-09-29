/**
 * app/api/v1/audio/transcriptions/route.ts
 *
 * Speech-to-text, exposed publicly as `POST /v1/audio/transcriptions`
 * (OpenAI-compatible multipart in, transcript JSON out).
 *
 * The uploaded audio is turned into a data URL once, here; the spec decides
 * whether to forward it as multipart, as a base64 JSON field, or as a URL.
 */
import {
  authorizeMediaRequest,
  executeMediaRequest,
  fileToDataUrl,
  mediaErrorResponse,
  type MediaRequestInput,
} from "@/lib/media/handler";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 25 MB matches OpenAI's documented limit. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      {
        ok: false,
        error: { code: "invalid_request", message: "expected multipart/form-data" },
      },
      { status: 400 },
    );
  }

  const model = typeof form.get("model") === "string" ? String(form.get("model")) : "";
  const auth = await authorizeMediaRequest(req, model);
  if (!auth.ok) return auth.response;

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return mediaErrorResponse({
      status: 400,
      code: "invalid_request",
      message: "an audio 'file' is required",
    });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return mediaErrorResponse({
      status: 400,
      code: "invalid_request",
      message: "'file' exceeds the 25MB limit",
    });
  }

  const language = typeof form.get("language") === "string" ? form.get("language") : undefined;
  const prompt = typeof form.get("prompt") === "string" ? form.get("prompt") : undefined;
  const temperature =
    typeof form.get("temperature") === "number" ? Number(form.get("temperature")) : undefined;

  const audio = await fileToDataUrl(file);
  const input: MediaRequestInput = {
    model,
    // `image` is the generic "input file (data URL)" slot; `extra.audio`
    // exposes the same value under a self-describing name for specs.
    image: audio,
    extra: {
      audio,
      filename: file.name,
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
  };

  const outcome = await executeMediaRequest({
    capability: "audio.stt",
    input,
    apiKey: auth.key,
    user: auth.user,
    signal: req.signal,
  });
  if (!outcome.ok) return mediaErrorResponse(outcome.error);

  const { result } = outcome.value;
  return Response.json({
    text: result.text ?? "",
    ...(result.taskId ? { id: result.taskId } : {}),
  });
}
