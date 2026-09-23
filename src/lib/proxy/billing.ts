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
import { computeCredits } from "../quota/rates";
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
  billingMode?: "usage" | "estimated";
}

export async function settleUsage(args: SettleUsageArgs): Promise<void> {
  const promptTokens = Math.max(0, Math.trunc(args.promptTokens));
  const completionTokens = Math.max(0, Math.trunc(args.completionTokens));
  const totalTokens = promptTokens + completionTokens;

  // 积分 consumed, in integer 0.001-积分 units, so even a tiny request
  // registers a fraction of a 积分 instead of being rounded up to a whole one.
  const creditsUsed = computeCredits({
    model: args.upstreamModel,
    promptTokens,
    completionTokens,
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
    await touchApiKeyLastUsed(args.apiKey.id);
  }

  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.provider.id,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens,
    completionTokens,
    creditsUsed,
    status: "success",
    billingMode: args.billingMode ?? "usage",
  });
}
