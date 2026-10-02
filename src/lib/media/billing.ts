/**
 * src/lib/media/billing.ts
 *
 * Settlement for media calls.
 *
 * Media is priced per **item produced**, not per token, so the charge is
 * `pricePerItem × successful items`. Failed or content-blocked images are not
 * charged — `executeMedia` already reports the upstream's success count.
 *
 * Media always draws on the account pool in 积分, even for accounts configured
 * in token mode: there is no natural token count for an image.
 */
import { touchApiKeyLastUsed } from "@/lib/db/keys";
import { incrementUserQuotaUsed } from "@/lib/db/users";
import { recordUsage } from "@/lib/db/usage";
import { CREDIT_SCALE } from "@/lib/quota/credits";
import type { ApiKey, User } from "@/lib/db/types";
import type { MediaCapability } from "./spec";

/**
 * Storage units (0.001 积分) to charge for producing `items` media items.
 *
 * `pricePerItem` is what the operator types in the panel: **whole 积分 per
 * item** (100 = 100 积分/张). Everything downstream — the usage row, the
 * account pool, the API — counts 0.001-积分 units, so the amount is converted
 * here. Forgetting this multiplication bills 1000× too little: `100` would be
 * stored as 100 units and read back as 0.1 积分.
 */
export function computeMediaCredits(pricePerItem: number, items: number): number {
  const perItem = Number.isFinite(pricePerItem) ? Math.max(0, Math.trunc(pricePerItem)) : 0;
  const count = Number.isFinite(items) ? Math.max(0, Math.trunc(items)) : 0;
  return perItem * CREDIT_SCALE * count;
}

export interface SettleMediaUsageArgs {
  apiKey: ApiKey;
  user: User;
  /** Media provider id (not a chat provider id). */
  providerId: string;
  model: string;
  upstreamModel: string;
  capability: MediaCapability;
  images: number;
  creditsUsed: number;
}

export async function settleMediaUsage(args: SettleMediaUsageArgs): Promise<void> {
  const creditsUsed = Math.max(0, Math.trunc(args.creditsUsed));
  const images = Math.max(0, Math.trunc(args.images));

  if (creditsUsed > 0) {
    await incrementUserQuotaUsed(args.apiKey.userId, creditsUsed);
  }

  // Every settled request touches the key, billed or not — see the same note
  // in proxy/billing.ts. A media model priced at 0 is unpriced, not unused.
  await touchApiKeyLastUsed(args.apiKey.id);

  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.providerId,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed,
    images,
    capability: args.capability,
    status: "success",
  });
}
