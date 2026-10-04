/**
 * src/lib/proxy/billing.ts
 *
 * Shared settlement step for every successful proxy call: compute 积分 from
 * the token counts, draw down the owner's pool, touch the key's
 * `lastUsedAt`, and write one usage row.
 *
 * Kept in its own module so `openai.ts` and `anthropic.ts` can both use it
 * without importing each other (openai already imports anthropic for the
 * Responses→Anthropic hop, so a reverse import would be a cycle).
 *
 * `billingMode` records how the token counts were obtained:
 *   - "usage"     — the upstream reported real counts
 *   - "estimated" — the stream ended without a usage frame, so counts are
 *                   derived from text length (chars ÷ 4, rounded up)
 */
import { touchApiKeyLastUsed } from "../db/keys";
import { incrementUserQuotaUsed } from "../db/users";
import { quotaDelta, recordUsage } from "../db/usage";
import { getModelConfig } from "../db/providers";
import { computeCredits, resolveModelRate, type CacheBuckets } from "../quota/rates";
import type { ApiKey, Provider, User } from "../db/types";

export interface SettleUsageArgs {
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  /** Client-visible model name (what the usage row shows). */
  model: string;
  /** Model name actually sent upstream (what the rate table keys on). */
  upstreamModel: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * What the upstream served from, and wrote into, its own prompt cache.
   *
   * Optional and defaulted, so a caller that does not look at the cache bills
   * exactly what it billed before — the same rate for the same tokens, and a
   * usage row with no cache columns rather than a row claiming a 0% hit rate.
   */
  cache?: CacheBuckets;
  billingMode?: "usage" | "estimated";
}

export async function settleUsage(args: SettleUsageArgs): Promise<void> {
  const promptTokens = Math.max(0, Math.trunc(args.promptTokens));
  const completionTokens = Math.max(0, Math.trunc(args.completionTokens));
  const cache = args.cache ?? { read: 0, write: 0, reported: false };
  // The cache is a *subset* of the prompt on the vendors that report it that
  // way, so the request did not consume more tokens than the prompt column
  // says. Adding the buckets to the total would inflate the token count that
  // quota modes are derived from, which is why this is the sum and not
  // `prompt + read + write`.
  const totalTokens = promptTokens + completionTokens;

  // 积分 consumed, in integer 0.001-积分 units, so even a tiny request
  // registers a fraction of a 积分 instead of being rounded up to a whole one.
  // Priced by the model row of the provider that answered — never by the
  // upstream model name (two vendors may charge differently for the same model,
  // and one may serve it for free).
  const creditsUsed = computeCredits({
    rate: resolveModelRate(getModelConfig(args.provider, args.model)),
    promptTokens,
    completionTokens,
    cache,
  });

  // The pool belongs to the USER, not the key: every key an account holds
  // draws down the same balance.
  const delta = quotaDelta({
    quotaType: args.user.quotaType,
    creditsUsed,
    totalTokens,
  });
  if (delta > 0) {
    await incrementUserQuotaUsed(args.apiKey.userId, delta);
  }

  // Touched on every settled request, not only a billed one. "Was this key
  // used?" and "was the user charged?" are different questions: a deployment
  // with no prices configured (0 means *not priced*, not free) produced
  // delta === 0 forever, so lastUsedAt stayed null on keys that were in fact
  // serving traffic, and the admin list showed them as never used.
  await touchApiKeyLastUsed(args.apiKey.id);

  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.provider.id,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens,
    completionTokens,
    creditsUsed,
    // Only recorded when the upstream actually reported a cache. A row that
    // says "0 cached" and a row that says "this vendor has no cache" are
    // different facts, and only the second one is a claim about the provider.
    ...(cache.reported
      ? { cachedPromptTokens: cache.read, cacheWriteTokens: cache.write }
      : {}),
    status: "success",
    billingMode: args.billingMode ?? "usage",
  });
}
