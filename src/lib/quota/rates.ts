/**
 * src/lib/quota/rates.ts
 *
 * Where a request's 积分 price comes from.
 *
 * The rate belongs to **one model row of one provider** — the client-facing
 * model id as it is mapped inside that provider. Prices differ between vendors
 * serving the same upstream model, and they differ between the models of a
 * single vendor, so the rate is stored on the model itself and nothing is
 * inferred from the model name.
 *
 * Rates are 积分 per 1,000,000 tokens, so the numbers stay small integers the
 * operator can type into the admin panel:
 *
 *   units (0.001-积分) = round(
 *     (promptTokens × inputPerMillion + completionTokens × outputPerMillion) / 1000
 *   )
 *
 * …minus whatever the upstream served from its own prompt cache, which is
 * priced separately. See {@link computeCredits} for how the two conventions
 * vendors use are told apart.
 *
 * A rate of 0 means free. There is no second level and no fallback: the value on
 * the model row is the whole answer, so "why did this cost that?" always has a
 * single, visible answer in the admin panel.
 *
 * There is deliberately no built-in price table and no implicit charge for
 * "unknown" models either: an unconfigured model costs nothing.
 */
import type { ModelConfig } from "../db/types";

export interface ModelRate {
  /** 积分 per 1,000,000 prompt (input) tokens. */
  inputPerMillion: number;
  /** 积分 per 1,000,000 completion (output) tokens. */
  outputPerMillion: number;
  /**
   * 积分 per 1,000,000 input tokens the upstream served from its cache.
   * Falls back to `inputPerMillion`: an unconfigured model must keep charging
   * the full input price for a cache read, not nothing.
   */
  cachedInputPerMillion?: number;
  /** 积分 per 1,000,000 input tokens written into the upstream's cache. */
  cacheWritePerMillion?: number;
}

/** Charging nothing — the default for a model with no rate configured. */
export const FREE_RATE: ModelRate = { inputPerMillion: 0, outputPerMillion: 0 };

/**
 * Rate of one model row. Missing config or a missing/garbled value means free.
 */
export function resolveModelRate(
  modelConfig?: Pick<
    ModelConfig,
    "inputCost" | "outputCost" | "cachedInputCost" | "cacheWriteCost"
  > | null,
): ModelRate {
  if (!modelConfig) return FREE_RATE;
  return {
    inputPerMillion: nonNegative(modelConfig.inputCost),
    outputPerMillion: nonNegative(modelConfig.outputCost),
    ...(modelConfig.cachedInputCost !== undefined
      ? { cachedInputPerMillion: nonNegative(modelConfig.cachedInputCost) }
      : {}),
    ...(modelConfig.cacheWriteCost !== undefined
      ? { cacheWritePerMillion: nonNegative(modelConfig.cacheWriteCost) }
      : {}),
  };
}

/**
 * The cache buckets an upstream reported, in this gateway's own spelling.
 *
 * Absent is meaningful and is not the same as zero: it means the vendor sent no
 * cache fields at all, so "this model has no caching" is a fact on the row
 * rather than a zero that reads as "0% hit rate".
 */
export interface CacheBuckets {
  /** Served from the upstream's cache. */
  read: number;
  /** Written into the upstream's cache by this request. */
  write: number;
  /** What the upstream reported, before any interpretation. */
  reported: boolean;
}

/**
 * Pull the cache buckets out of whatever an upstream called them.
 *
 * There is no standard. OpenAI puts a subset under
 * `prompt_tokens_details.cached_tokens`; Anthropic reports two disjoint buckets
 * beside `input_tokens`; DeepSeek names them
 * `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`; several compatible
 * vendors use bare `cached_tokens`. This reads all of them and takes the
 * largest plausible hit count, because the wrong-but-smaller number is the one
 * that quietly under-discounts.
 *
 * `cache_creation` has two spellings in the wild (`cache_creation_input_tokens`
 * and `cache_creation_tokens`) and no third is worth guessing at.
 */
export function extractCacheBuckets(usage: unknown): CacheBuckets {
  const none: CacheBuckets = { read: 0, write: 0, reported: false };
  if (!usage || typeof usage !== "object") return none;
  const u = usage as Record<string, unknown>;

  const toCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value)
      : 0;

  // OpenAI's own shape, and the one most compatible vendors copy.
  const details = (u.prompt_tokens_details ?? u.input_tokens_details) as
    | Record<string, unknown>
    | undefined;
  const openAiCached = toCount(details?.cached_tokens);
  const bareCached = toCount(u.cached_tokens);

  // DeepSeek names the hit and the miss; the hit is what we need.
  const deepSeekHit = toCount(u.prompt_cache_hit_tokens);

  // Anthropic's two disjoint buckets.
  const anthropicRead = toCount(u.cache_read_input_tokens);
  const anthropicWrite = toCount(
    u.cache_creation_input_tokens ?? u.cache_creation_tokens,
  );

  const read = Math.max(openAiCached, bareCached, deepSeekHit, anthropicRead);
  const write = anthropicWrite;
  return { read, write, reported: read > 0 || write > 0 };
}

/**
 * How many 积分 a request consumed, as an integer count of 0.001-积分 units
 * (see `credits.ts`). Non-finite or negative token counts count as zero.
 *
 * **The cache convention is detected per request, not configured.** Vendors
 * disagree about whether `prompt_tokens` already contains the cached portion:
 * OpenAI's does, Anthropic's does not, and this gateway cannot ask.
 *
 *   read + write ≤ promptTokens → the cache is a *subset* of the prompt. A
 *     subset cannot exceed its whole, so this reading is provably the one that
 *     produced these numbers. The uncached remainder is `prompt − buckets` and
 *     the three priced buckets add up to exactly `promptTokens`.
 *
 *   read + write > promptTokens → the subset reading is impossible, so the
 *     buckets are *disjoint* from the prompt (the Anthropic shape) and they are
 *     added on top.
 *
 * So the two branches cannot be swapped by a vendor's shape, and the result is
 * always one of the two correct readings. The residual risk is the reverse: a
 * vendor using the disjoint shape whose buckets happen to be smaller than its
 * own prompt count is read as a subset, and the discount is lost — which costs
 * revenue for a turn rather than invoicing a user for tokens nobody paid for.
 */
export function computeCredits(args: {
  rate: ModelRate;
  promptTokens: number;
  completionTokens: number;
  /** Defaults to no caching, so a caller that does not look costs the same as before. */
  cache?: CacheBuckets;
}): number {
  const promptTokens = toTokenCount(args.promptTokens);
  const completionTokens = toTokenCount(args.completionTokens);
  const input = nonNegative(args.rate.inputPerMillion);
  const output = nonNegative(args.rate.outputPerMillion);
  // Unset = the same as the input price. Not zero: a model configured before
  // caching existed must keep charging full price for a cache read.
  const cached = nonNegative(args.rate.cachedInputPerMillion ?? args.rate.inputPerMillion);
  const cacheWrite = nonNegative(args.rate.cacheWritePerMillion ?? args.rate.inputPerMillion);

  const read = toTokenCount(args.cache?.read);
  const write = toTokenCount(args.cache?.write);
  const buckets = read + write;

  const promptCredits =
    buckets <= promptTokens
      ? // Cache is a subset: charge the remainder at the input price.
        Math.max(0, promptTokens - buckets) * input + read * cached + write * cacheWrite
      : // Cache is disjoint from the prompt: charge all three on top.
        promptTokens * input + read * cached + write * cacheWrite;

  const total = (promptCredits + completionTokens * output) / 1000;
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, Math.round(total));
}

/**
 * Coerce a token count into a non-negative finite integer. Accepts undefined
 * because "no cache reported" is a real state and has to read as zero here
 * rather than as NaN.
 */
function toTokenCount(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Missing / malformed rates are treated as "not charged". */
function nonNegative(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}
