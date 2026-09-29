/**
 * src/lib/media/seeds.ts
 *
 * Ready-made specs. These are ordinary documents, not code: the admin panel can
 * import, edit and re-export them, which is exactly the workflow the protocol
 * is meant to enable ("read the vendor's docs, adjust the field names, done").
 */
import type { MediaSpec } from "./spec";

/** OpenAI `size` → MiniMax `aspect_ratio` (best effort, 1:1 fallback). */
const SIZE_TO_ASPECT: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
  "1792x1024": "16:9",
  "1024x1792": "9:16",
  "1344x768": "16:9",
  "768x1344": "9:16",
};

/**
 * MiniMax image generation (`POST /v1/image_generation`).
 *
 * Serves both `/v1/images/generations` and `/v1/images/edits`; an edit simply
 * adds `subject_reference`. That is a *character reference* (keep the subject
 * consistent), NOT a masked/instruction edit — hence `edit_mode: "reference"`,
 * which is surfaced to clients through `/v1/models`.
 */
export const MINIMAX_IMAGE_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "image.generate",
  displayName: "MiniMax Image (image-01 / image-01-live)",
  transport: {
    method: "POST",
    path: "/v1/image_generation",
    contentType: "application/json",
  },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    prompt: "$.prompt",
    n: "$.n",
    seed: "$.seed",
    style: "$.style",
    prompt_optimizer: "$.prompt_optimizer",
    aigc_watermark: "$.watermark",
    aspect_ratio: {
      $mapSize: { path: "$.size", table: SIZE_TO_ASPECT, default: "1:1" },
    },
    response_format: {
      $enum: {
        path: "$.response_format",
        map: { b64_json: "base64", url: "url" },
        default: "url",
      },
    },
    subject_reference: {
      $ifPresent: {
        "$.image": [{ type: "character", image_file: { $dataUrl: "$.image" } }],
      },
    },
  },
  response: {
    items: { $from: "$.data.image_urls", $to: { kind: "url", value: "$" } },
    itemsB64: { $from: "$.data.image_base64", $to: { kind: "base64", value: "$" } },
    successCount: "$.metadata.success_count",
    errorCode: "$.base_resp.status_code",
    errorMessage: "$.base_resp.status_msg",
    taskId: "$.id",
  },
  errors: [
    { when: { $eq: ["$.base_resp.status_code", 1002] }, status: 429, code: "rate_limited", message: "upstream rate limited the request" },
    { when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed", message: "upstream rejected the credentials" },
    { when: { $eq: ["$.base_resp.status_code", 1008] }, status: 402, code: "upstream_credit_exhausted", message: "upstream account is out of credit" },
    { when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter", message: "prompt was rejected by upstream content policy" },
    { when: { $eq: ["$.base_resp.status_code", 2013] }, status: 400, code: "bad_request", message: "upstream rejected the parameters" },
    { when: { $eq: ["$.base_resp.status_code", 2049] }, status: 502, code: "upstream_auth_failed", message: "upstream API key is invalid" },
  ],
  limits: { maxN: 9, timeoutMs: 120_000 },
  metadata: {
    modes: ["text-to-image", "image-to-image"],
    edit_mode: "reference",
    sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"],
    max_n: 9,
    max_reference_images: 1,
  },
};

/**
 * OpenAI-compatible text-to-speech. `responseMode: "binary"` is what makes the
 * engine hand the audio bytes straight back instead of JSON-parsing them.
 */
export const OPENAI_TTS_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "audio.tts",
  displayName: "OpenAI-compatible TTS",
  transport: { method: "POST", path: "/audio/speech" },
  auth: { type: "bearer" },
  responseMode: "binary",
  request: {
    model: "$.model",
    input: "$.input",
    voice: "$.voice",
    speed: "$.speed",
    response_format: "$.responseFormat",
  },
  limits: { timeoutMs: 120_000 },
  metadata: { modes: ["text-to-speech"], input_field: "input" },
};

/**
 * OpenAI-compatible transcription. The inbound audio is already a data URL;
 * `$file` turns it into a real multipart file part on the way out.
 */
export const OPENAI_STT_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "audio.stt",
  displayName: "OpenAI-compatible transcription",
  transport: { method: "POST", path: "/audio/transcriptions", contentType: "multipart/form-data" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    file: {
      $file: { path: "$.image", filename: "$.filename", contentType: "application/octet-stream" },
    },
    language: "$.language",
    prompt: "$.prompt",
  },
  response: { text: "$.text", taskId: "$.id" },
  limits: { timeoutMs: 120_000 },
  metadata: { modes: ["speech-to-text"], input_field: "file" },
};

/** Template for vendors that answer with a task id you poll. */
export const ASYNC_VIDEO_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "video.generate",
  displayName: "Async video vendor (submit + poll)",
  transport: { method: "POST", path: "/v1/videos" },
  auth: { type: "bearer" },
  request: { model: "$.model", prompt: "$.prompt", n: "$.n" },
  response: {
    taskId: "$.task_id",
    status: "$.status",
    items: { $from: "$.output.urls", $to: { kind: "url", value: "$" } },
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v1/videos/{{taskId}}",
      intervalMs: 3000,
      timeoutMs: 240_000,
      statusPath: "$.status",
      successValues: ["SUCCEEDED", "succeeded", "SUCCESS", "success"],
      failureValues: ["FAILED", "failed", "CANCELLED"],
    },
  },
  limits: { timeoutMs: 240_000 },
  metadata: { modes: ["text-to-video"], async: true },
};

/** Importable starting points an operator can load and then adjust. */
export const MEDIA_TEMPLATES: Record<
  string,
  { name: string; baseUrl: string; models: Record<string, unknown>; specs: MediaSpec[] }
> = {
  "minimax-image": {
    name: "MiniMax Image",
    baseUrl: "https://api.minimax.cn",
    models: {
      "image-01": { upstreamId: "image-01", pricePerItem: 0, enabled: true },
      "image-01-live": { upstreamId: "image-01-live", pricePerItem: 0, enabled: true },
    },
    specs: [MINIMAX_IMAGE_SPEC],
  },
  "openai-audio": {
    name: "OpenAI Audio",
    baseUrl: "https://api.openai.com",
    models: {
      "gpt-4o-mini-tts": { upstreamId: "gpt-4o-mini-tts", pricePerItem: 0, enabled: true },
      "whisper-1": { upstreamId: "whisper-1", pricePerItem: 0, enabled: true },
    },
    specs: [OPENAI_TTS_SPEC, OPENAI_STT_SPEC],
  },
  "async-video": {
    name: "Async video vendor",
    baseUrl: "https://api.example.com",
    models: { "video-01": { upstreamId: "video-01", pricePerItem: 0, enabled: true } },
    specs: [ASYNC_VIDEO_SPEC],
  },
};
