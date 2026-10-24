/**
 * src/lib/proxy/dialects/shared.ts
 *
 * What the three upstream dialects have in common.
 *
 * Reading an SSE body and filing a failed turn are the same in every
 * dialect, so they are written once here rather than three times.
 */

import { recordUsage } from "../../db/usage";
import { extractCacheBuckets, type CacheBuckets } from "../../quota/rates";
import type { ApiKey, Provider } from "../../db/types";
import type { StreamUsage } from "../types";

/**
 * True when the upstream answered with an SSE body. Some providers ignore
 * `stream: true` and reply with a buffered JSON completion; those must not be
 * piped through the SSE tap (they would bill as an empty estimate).
 */
export function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Pull token usage out of a Responses SSE event payload, accepting both the
 * Chat (`prompt_tokens`) and Responses (`input_tokens`) spellings, at either
 * the top level or nested under `response`.
 */
export function usageFromSsePayload(payload: unknown): StreamUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nested = record.response;
  const source =
    (record.usage as Record<string, unknown> | undefined) ??
    (nested && typeof nested === "object"
      ? ((nested as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined);
  if (!source) return null;

  const toInt = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  const promptTokens = toInt(source.prompt_tokens ?? source.input_tokens);
  const completionTokens = toInt(source.completion_tokens ?? source.output_tokens);
  const totalTokens = toInt(source.total_tokens) || promptTokens + completionTokens;
  // `source` is the raw upstream object, so the vendor's own spelling of the
  // cache buckets is still on it. Read before it is discarded.
  return { promptTokens, completionTokens, totalTokens, cache: extractCacheBuckets(source) };
}

export async function recordFailure(args: {
  apiKey: ApiKey;
  provider: Provider;
  model: string;
  upstreamModel: string;
  error: unknown;
}): Promise<void> {
  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.provider.id,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed: 0,
    status: "error",
    errorMessage: String(args.error),
  });
}
