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
import type { ApiKey, User } from "@/lib/db/types";
import type { MediaCapability } from "./spec";

/** 积分 (0.001 units) for producing `items` media items at `pricePerItem`. */
export function computeMediaCredits(pricePerItem: number, items: number): number {
  const unit = Math.max(0, Math.trunc(pricePerItem));
  const count = Math.max(0, Math.trunc(items));
  return unit * count;
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
    await touchApiKeyLastUsed(args.apiKey.id);
  }

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
