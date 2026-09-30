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
import { buildMediaScope, executeMedia, type MediaItem, type MediaResult } from "./engine";
import type { MediaCapability, MediaProvider, MediaSpec } from "./spec";
import type { ApiKey, User } from "@/lib/db/types";

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
  image?: string;
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
  const { capability, input, apiKey, user } = args;

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
  const rejection = shouldRejectBeforeRequest(user);
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

  const execution = await executeMedia({
    spec,
    provider: resolved.provider,
    input: buildScope(input),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (!execution.ok) return { ok: false, error: execution.error };

  const credits = computeMediaCredits(
    resolved.pricePerItem,
    execution.result.successCount,
  );
  if (args.charge !== false) {
    await settleMediaUsage({
      apiKey,
      user,
      providerId: resolved.provider.id,
      model: input.model,
      upstreamModel: resolved.upstreamId,
      capability: spec.capability,
      images: execution.result.successCount,
      creditsUsed: credits,
    });
  }

  return {
    ok: true,
    value: {
      result: execution.result,
      provider: resolved.provider,
      spec,
      model: input.model,
      upstreamModel: resolved.upstreamId,
      credits,
    },
  };
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

/** Render a failure as the relay's standard `{ok:false,error:{…}}` JSON. */
export function mediaErrorResponse(error: MediaRequestFailure): Response {
  return Response.json(
    { ok: false, error: { code: error.code, message: error.message } },
    { status: error.status },
  );
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
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: { code: http.code, message: http.message } },
        { status: http.status },
      ),
    };
  }

  const owner = auth.user ?? (await getUserById(auth.key.userId));
  if (!owner) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: {
            code: "user_not_found",
            message: "The account owning this key no longer exists",
          },
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, key: auth.key as ApiKey, user: owner };
}
