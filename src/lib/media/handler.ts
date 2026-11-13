/**
 * src/lib/media/handler.ts
 *
 * Shared glue for every media endpoint: resolve the media provider + spec for a
 * request, run the spec through the engine, settle the charge, and hand back
 * the engine's result. Each route then shapes that result into its own
 * OpenAI-compatible response (images / audio / video / music).
 */
import { pickSpecForRequest, resolveMediaProviderForModel } from "@/lib/db/media-providers";
import { shouldRejectBeforeRequest } from "@/lib/quota/calculator";
import { computeMediaCredits, settleMediaUsage } from "./billing";
import { buildMediaScope, executeMedia, resumeMedia, submitMedia, type MediaItem, type MediaResult } from "./engine";
import { isPassthroughMode, type MediaCapability, type MediaProvider, type MediaSpec } from "./spec";
import type { ApiKey, User } from "@/lib/db/types";
import { proxyError } from "@/lib/proxy/errors";
import { DEFAULT_SPEC_TIMEOUT_MS } from "@/lib/protocol/limits";

/** Normalized request, independent of which endpoint it arrived on. */
export interface MediaRequestInput {
  model: string;
  /** Image / video / music prompt. */
  prompt?: string;
  /** Speech-to-text turns it around: the text to synthesize (TTS). */
  input?: string;
  n?: number;
  size?: string;
  responseFormat?: string;
  /**
   * The first uploaded reference image, as a data URL.
   *
   * Kept because every existing `image.edit` spec maps it, and because "one
   * picture" is still the common case. New specs that want every reference
   * should read `images` instead.
   */
  image?: string;
  /**
   * Every uploaded reference image, in the order the client sent them.
   *
   * `/v1/images/edits` takes a repeatable `image` field (OpenAI's `image[]`), so
   * a client can send 1–16 references. The scope exposes them as a plain array
   * of data URLs; a spec turns them into the vendor's shape with
   * `{"$from": "$.images", "$to": …}` (see the protocol's §0.4.7).
   *
   * `images[0]` is always the same string as `image`, so a spec can move between
   * the two without changing meaning.
   */
  images?: string[];
  seed?: number;
  style?: string;
  watermark?: boolean;
  promptOptimizer?: boolean;
  /** Transcription language hint. */
  language?: string;
  /** Synthesis voice hint. */
  voice?: string;
  speed?: number;
  user?: string;
  /** Anything else a spec may reference, passed through untouched. */
  extra?: Record<string, unknown>;
}

export interface MediaRequestFailure {
  status: number;
  code: string;
  message: string;
}

export type MediaRequestOutcome =
  | { ok: true; response: Record<string, unknown>; settledCredits: number }
  | { ok: false; error: MediaRequestFailure };

export interface MediaExecutionSuccess {
  result: MediaResult;
  provider: MediaProvider;
  spec: MediaSpec;
  model: string;
  upstreamModel: string;
  credits: number;
}

export type MediaExecutionOutcome =
  | { ok: true; value: MediaExecutionSuccess }
  | { ok: false; error: MediaRequestFailure };

/** The scope a spec's mapping is evaluated against. */
export function buildScope(input: MediaRequestInput): Record<string, unknown> {
  return buildMediaScope({ ...input } as Record<string, unknown>);
}

/**
 * Resolve → quota check → execute → settle.
 *
 * Billing happens for every successful call, including binary/text results
 * (one "item" per generated audio file or per transcription).
 */
/** The provider row plus the upstream model id a spec resolved to. */
type MediaResolvedProvider = NonNullable<Awaited<ReturnType<typeof resolveMediaProviderForModel>>>;

/** A media call after resolution: the provider row, the spec, the price. */
type PreparedMediaCall = { ok: true; spec: MediaSpec; resolved: MediaResolvedProvider } | { ok: false; error: MediaRequestFailure };

/**
 * Resolve the model to a provider and the spec that serves this capability.
 *
 * Shared by the three entry points below (execute / submit / resume) so a rule
 * about which provider serves what cannot drift between them.
 */
async function prepareMediaCall(args: {
  capability: MediaCapability;
  input: MediaRequestInput;
  user: User;
  /**
   * Skip the credit-pool check.
   *
   * A resumed job was already admitted and the vendor already ran it; refusing
   * to collect its result because the pool emptied in the meantime would charge
   * the upstream work and hand the caller nothing.
   */
  skipPreflight?: boolean;
}): Promise<PreparedMediaCall> {
  const { capability, input, user } = args;

  // An absent model is a malformed request, not a missing resource: reporting
  // it as 404 with an interpolated empty string ("model '' is not an
  // available media model") tells the caller nothing they can act on.
  if (!input.model?.trim()) {
    return {
      ok: false,
      error: { status: 400, code: "invalid_request", message: "model is required" },
    };
  }

  const resolved = await resolveMediaProviderForModel(input.model);
  if (!resolved) {
    return {
      ok: false,
      error: {
        status: 404,
        code: "model_not_found",
        message: `model '${input.model}' is not an available media model`,
      },
    };
  }

  // A passthrough provider has no mapping to translate through. Saying so here is
  // the difference between "capability not supported" and "you are calling the
  // wrong surface".
  if (isPassthroughMode(resolved.provider.mode)) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "provider_is_passthrough",
        message:
          `provider '${resolved.provider.name}' is in ${resolved.provider.mode} mode; ` +
          `call it through /v1/raw/${resolved.provider.id}/<vendor path>?model=${input.model}`,
      },
    };
  }

  const spec = pickSpecForRequest(resolved.provider, capability, input.model);
  if (!spec) {
    return {
      ok: false,
      error: {
        status: 400,
        code: "capability_not_supported",
        message: `provider '${resolved.provider.name}' does not serve ${capability}`,
      },
    };
  }

  // Same pool rule as chat: once the account is spent, stop before spending
  // anything upstream.
  const rejection = args.skipPreflight ? null : shouldRejectBeforeRequest(user);
  if (rejection) {
    return {
      ok: false,
      error: {
        status: 403,
        code: rejection.reason,
        message: "account credit pool is exhausted",
      },
    };
  }

  return { ok: true, spec, resolved };
}

/**
 * The spec's own deadline, made real.
 *
 * `limits.timeoutMs` was documentation: it was validated on save and then
 * never consulted, so a spec that declared 120s could run for the route's
 * whole allowance and a spec that declared 570s was silently cut at 240s by
 * that same route. A limit nothing enforces is a number an operator sizes
 * their work against and then cannot rely on.
 */
function mediaCallSignal(signal: AbortSignal | undefined, spec: MediaSpec): AbortSignal {
  const specBudget = spec.limits?.timeoutMs ?? DEFAULT_SPEC_TIMEOUT_MS;
  const budgetSignal = AbortSignal.timeout(specBudget);
  return signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
}

/**
 * Charge for a finished result and hand it back.
 *
 * One function because a resumed job and a synchronous call must settle
 * identically — a second copy here is a second place for the price to disagree
 * with the charge.
 */
async function settleMediaSuccess(args: {
  capability: MediaCapability;
  input: MediaRequestInput;
  apiKey: ApiKey;
  user: User;
  spec: MediaSpec;
  resolved: MediaResolvedProvider;
  result: MediaResult;
  charge: boolean;
}): Promise<MediaExecutionOutcome> {
  const { capability, input, apiKey, user, spec, resolved, result } = args;

  // Refuse (and do not charge) a result this capability's endpoint cannot deliver.
  // Only `audio.tts` has such a contract today: it answers with bytes, so a spec
  // that maps the audio to a URL is unusable no matter how well it mapped.
  if (spec.capability === "audio.tts" && !audioDelivery(result, input.responseFormat)) {
    return {
      ok: false,
      error: {
        status: 502,
        code: "no_audio",
        message:
          "upstream returned no usable audio — /v1/audio/speech answers with bytes, so map the " +
          'audio to a base64 item (e.g. {"kind":"base64","encoding":"hex",…}) or a byte stream',
      },
    };
  }

  const credits = computeMediaCredits(resolved.pricePerItem, result.successCount);
  if (args.charge) {
    await settleMediaUsage({
      apiKey,
      user,
      providerId: resolved.provider.id,
      model: input.model,
      upstreamModel: resolved.upstreamId,
      capability,
      images: result.successCount,
      creditsUsed: credits,
    });
  }

  return {
    ok: true,
    value: { result, provider: resolved.provider, spec, model: input.model, upstreamModel: resolved.upstreamId, credits },
  };
}

export async function executeMediaRequest(args: {
  capability: MediaCapability;
  input: MediaRequestInput;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Set false for endpoints that must not be charged (none today, kept explicit). */
  charge?: boolean;
}): Promise<MediaExecutionOutcome> {
  const prepared = await prepareMediaCall(args);
  if (!prepared.ok) return prepared;

  const execution = await executeMedia({
    spec: prepared.spec,
    provider: prepared.resolved.provider,
    input: buildScope(args.input),
    signal: mediaCallSignal(args.signal, prepared.spec),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (!execution.ok) return { ok: false, error: execution.error };

  return settleMediaSuccess({
    capability: args.capability,
    input: args.input,
    apiKey: args.apiKey,
    user: args.user,
    spec: prepared.spec,
    resolved: prepared.resolved,
    result: execution.result,
    charge: args.charge !== false,
  });
}

/**
 * Submit a generation and stop at the upstream task id.
 *
 * This is the restart-safe half: for a spec with `async.poll` the vendor keeps
 * working after this process forgets, so the id is what a job persists. A
 * synchronous vendor has nothing to hand back, and answers with the finished
 * result exactly like `executeMediaRequest`.
 */
export async function submitMediaRequest(args: {
  capability: MediaCapability;
  input: MediaRequestInput;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; pending: { taskId: string; providerId: string; upstreamId: string } }
  | MediaExecutionOutcome
> {
  const prepared = await prepareMediaCall(args);
  if (!prepared.ok) return prepared;

  const submission = await submitMedia({
    spec: prepared.spec,
    provider: prepared.resolved.provider,
    input: buildScope(args.input),
    signal: mediaCallSignal(args.signal, prepared.spec),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (!submission.ok) return { ok: false, error: submission.error };

  if ("pending" in submission) {
    return {
      ok: true,
      pending: {
        taskId: submission.pending.taskId,
        providerId: prepared.resolved.provider.id,
        upstreamId: prepared.resolved.upstreamId,
      },
    };
  }

  return settleMediaSuccess({
    capability: args.capability,
    input: args.input,
    apiKey: args.apiKey,
    user: args.user,
    spec: prepared.spec,
    resolved: prepared.resolved,
    result: submission.result,
    charge: true,
  });
}

/**
 * Resume polling a task id stored by an earlier process.
 *
 * `providerId` is checked on purpose: a model may have been re-pointed at
 * another provider since the job was submitted, and polling it with a different
 * vendor's credentials would be a request to the wrong account — failing here is
 * the honest outcome.
 */
export async function resumeMediaRequest(args: {
  capability: MediaCapability;
  input: MediaRequestInput;
  apiKey: ApiKey;
  user: User;
  taskId: string;
  providerId?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  charge?: boolean;
}): Promise<MediaExecutionOutcome> {
  const prepared = await prepareMediaCall({ ...args, skipPreflight: true });
  if (!prepared.ok) return prepared;

  if (args.providerId && args.providerId !== prepared.resolved.provider.id) {
    return {
      ok: false,
      error: {
        status: 409,
        code: "provider_changed",
        message: "this job was submitted to a different provider; submit it again",
      },
    };
  }

  const execution = await resumeMedia({
    spec: prepared.spec,
    provider: prepared.resolved.provider,
    input: buildScope(args.input),
    taskId: args.taskId,
    signal: mediaCallSignal(args.signal, prepared.spec),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (!execution.ok) return { ok: false, error: execution.error };

  return settleMediaSuccess({
    capability: args.capability,
    input: args.input,
    apiKey: args.apiKey,
    user: args.user,
    spec: prepared.spec,
    resolved: prepared.resolved,
    result: execution.result,
    charge: args.charge !== false,
  });
}
/**
 * Items to report to an OpenAI-shaped client, given a possibly binary result.
 *
 * `responseMode: "binary"` covers vendors that stream image bytes (Stability's
 * `Accept: image/*`). Those results carry no `items`, so the images endpoint used
 * to answer `{"data":[]}` while still charging for one item. Converting the bytes
 * into a `b64_json` item keeps the OpenAI shape and makes the charge match what
 * the client received. `/v1/audio/speech` still returns raw bytes — that *is* its
 * shape.
 */
export async function resultItems(result: MediaResult): Promise<MediaItem[]> {
  if (result.items.length > 0) return result.items;
  if (!result.binary) return result.items;
  const body = result.binary.body.byteLength > 0 ? result.binary.body : await drain(result.binary.stream);
  if (!body || body.byteLength === 0) return result.items;
  const bytes = new Uint8Array(body);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return [{ kind: "base64", value: btoa(binary) }];
}

async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<ArrayBuffer | undefined> {
  if (!stream) return undefined;
  return new Response(stream).arrayBuffer();
}

/** Content type for a JSON-shaped vendor's audio, from the requested format. */
export function audioMimeType(format: string | undefined): string {
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

export type AudioDelivery =
  | { kind: "bytes"; bytes: Uint8Array; contentType: string }
  | { kind: "stream"; stream: ReadableStream<Uint8Array>; contentType: string };

/**
 * The bytes `/v1/audio/speech` can hand back for a result, or null if it cannot.
 *
 * Two vendor shapes converge here: those that stream/buffer audio (binary,
 * stream), and those that answer JSON (MiniMax's `t2a_v2` gives hex or a URL) —
 * the latter must map its audio to a `base64` item.
 *
 * This lives in the handler rather than the route because billing happens here,
 * and a result the endpoint cannot deliver must not be charged. Production
 * evidence: five charges for one successful synthesis, because the route's
 * `no_audio` check ran *after* the charge had been settled.
 */
export function audioDelivery(
  result: MediaResult,
  requestedFormat?: string,
): AudioDelivery | null {
  if (result.binary) {
    const contentType = result.binary.contentType ?? audioMimeType(requestedFormat);
    if (result.binary.stream) {
      return { kind: "stream", stream: result.binary.stream, contentType };
    }
    if (result.binary.body.byteLength > 0) {
      return { kind: "bytes", bytes: new Uint8Array(result.binary.body), contentType };
    }
    return null;
  }
  const encoded = result.items.find((item) => item.kind === "base64");
  if (!encoded) return null;
  try {
    const binaryString = atob(encoded.value);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return { kind: "bytes", bytes, contentType: audioMimeType(requestedFormat) };
  } catch {
    return null;
  }
}

/** OpenAI Images response from normalized media items. */
export function imageItemsResponse(
  items: MediaItem[],
  createdAt = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    created: createdAt,
    data: items.map((item) =>
      item.kind === "base64" ? { b64_json: item.value } : { url: item.value },
    ),
  };
}

/**
 * OpenAI-ish response for generated media that is not images (video, music).
 * Same shape, plus the task id we surfaced from the provider.
 */
export function mediaItemsResponse(
  items: MediaItem[],
  taskId: string | undefined,
  createdAt = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    created: createdAt,
    ...(taskId ? { id: taskId } : {}),
    status: "succeeded",
    data: items.map((item) => (item.kind === "base64" ? { b64_json: item.value } : { url: item.value })),
  };
}

/** Validate the prompt-ish field shared by image/video/music calls. */
export function requirePrompt(prompt: string | undefined, maxLength = 1500): MediaRequestFailure | null {
  const value = prompt?.trim();
  if (!value) {
    return { status: 400, code: "invalid_request", message: "prompt is required" };
  }
  if (value.length > maxLength) {
    return {
      status: 400,
      code: "invalid_request",
      message: `prompt is too long (max ${maxLength} characters)`,
    };
  }
  return null;
}

/** Convert a multipart file into a data URL so specs can forward it. */
export async function fileToDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const type = file.type || "image/png";
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Render a failure as the OpenAI-facing error envelope.
 *
 * Only the `/v1/*` media routes use this. The assistant's own media tester
 * (`/api/assistant/test-media`) defines its own local copy of the same helper,
 * because that endpoint is on the session surface and answers in
 * `{ok:false,error:{…}}` — the two surfaces have different envelopes, and the
 * split is deliberate rather than an oversight.
 */
export function mediaErrorResponse(error: MediaRequestFailure): Response {
  return proxyError(error.status, error.code, error.message);
}

/**
 * Authenticate a media call with the same API key the chat surface uses.
 * Returns a ready-to-return error response, or the key and its owner.
 */
export async function authorizeMediaRequest(
  req: Request,
  requestedModel: string,
): Promise<
  { ok: true; key: ApiKey; user: User } | { ok: false; response: Response }
> {
  const { authenticateBearer, reasonToHttp, resolveAuthHeader } = await import(
    "@/lib/auth/apikey"
  );
  const { getUserById } = await import("@/lib/db/users");

  const auth = await authenticateBearer({
    authHeader: resolveAuthHeader(req),
    requestedModel,
  });
  // The rejections below are built here rather than returned as data for the
  // route to shape, so they have to be built in the right envelope here — a
  // route that converted them would be one more place to forget, and the failure
  // is invisible until a real client sends a real request. Auth is the first gate
  // every media call passes through, so this is the error a client meets first.
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return { ok: false, response: proxyError(http.status, http.code, http.message) };
  }

  const owner = auth.user ?? (await getUserById(auth.key.userId));
  if (!owner) {
    return {
      ok: false,
      response: proxyError(
        403,
        "user_not_found",
        "The account owning this key no longer exists",
      ),
    };
  }
  return { ok: true, key: auth.key as ApiKey, user: owner };
}
