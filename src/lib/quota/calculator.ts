/**
 * src/lib/quota/calculator.ts
 *
 * Quota decision helpers used by the proxy layer.
 *
 * The full request flow is:
 *   1. Authenticate the API key (lib/auth/apikey.ts).
 *   2. Decide if the request would be rejected by quota (shouldReject).
 *   3. Forward to upstream provider.
 *   4. Compute 积分 consumed from the response.
 *   5. Bump the OWNER's quotaUsed (lib/db/users.ts).
 *   6. Record a usage log (lib/db/usage.ts).
 *
 * This module owns step 2 and the small helpers around step 4.
 */
import { computeCredits } from "./rates";
import type { ApiKey, QuotaType, UsageLog, User } from "../db/types";

// ---------------------------------------------------------------------------
// Pre-flight quota check
// ---------------------------------------------------------------------------

/**
 * Decide whether a request should be rejected before forwarding.
 *
 * Note: this only rejects when quotaUsed has already exceeded quotaLimit.
 * In `credits` mode this is the *previous* usage. The new request's usage is
 * unknown until we get one back, so we allow the request to proceed; if
 * the response makes quotaUsed cross the limit, the caller may decide
 * to disable the key (handled in v2 — for now we just record).
 *
 * The other reasons (disabled, expired) are already enforced in
 * `lib/auth/apikey.ts`. This function only adds a defensive double-check.
 */
export function shouldRejectBeforeRequest(user: Pick<User, "quotaType" | "quotaLimit" | "quotaUsed">): false | {
  reason: "quota_exceeded_credits" | "quota_exceeded_tokens";
} {
  if (user.quotaType === "credits" && user.quotaUsed >= user.quotaLimit) {
    return { reason: "quota_exceeded_credits" };
  }
  if (user.quotaType === "tokens" && user.quotaUsed >= user.quotaLimit) {
    return { reason: "quota_exceeded_tokens" };
  }
  return false;
}

/**
 * Decide whether the *response* should be recorded as over-quota.
 * Used after a successful request to mark the key for auto-disable.
 *
 * Auto-disable behavior is configurable per quota engine. We default
 * to "record only; let admin decide" because disabling on the first
 * over-quota request can surprise users mid-conversation.
 */
export function isOverQuotaAfterRequest(args: {
  user: Pick<User, "quotaLimit">;
  newQuotaUsed: number;
}): boolean {
  return args.newQuotaUsed > args.user.quotaLimit;
}

// ---------------------------------------------------------------------------
// Usage → quota delta
// ---------------------------------------------------------------------------

/**
 * Convert a response's token counts into the quota delta that should
 * be added to `quotaUsed`.
 *
 * For `quotaType=credits`, delta = 积分 consumed (integer 0.001-积分 units).
 * For `quotaType=tokens`, delta = totalTokens.
 */
export function quotaDeltaFromUsage(args: {
  quotaType: QuotaType;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
}): number {
  const total = args.usage.promptTokens + args.usage.completionTokens;
  if (args.quotaType === "tokens") return total;
  return computeCredits({
    model: args.model,
    promptTokens: args.usage.promptTokens,
    completionTokens: args.usage.completionTokens,
  });
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/**
 * Group a list of UsageLog records by YYYY-MM-DD in the user's local
 * timezone (or UTC if no timezone provided). Used by the admin
 * "usage by day" endpoint.
 */
export function aggregateByDay(
  logs: UsageLog[],
  tzOffsetMinutes = 0,
): Array<{ day: string; promptTokens: number; completionTokens: number; creditsUsed: number; requests: number }> {
  const buckets = new Map<string, {
    promptTokens: number;
    completionTokens: number;
    creditsUsed: number;
    requests: number;
  }>();

  for (const log of logs) {
    if (log.status !== "success") continue;
    const day = isoDateInTz(log.createdAt, tzOffsetMinutes);
    const cur = buckets.get(day) ?? {
      promptTokens: 0,
      completionTokens: 0,
      creditsUsed: 0,
      requests: 0,
    };
    cur.promptTokens += log.promptTokens;
    cur.completionTokens += log.completionTokens;
    cur.creditsUsed += log.creditsUsed;
    cur.requests += 1;
    buckets.set(day, cur);
  }

  return Array.from(buckets, ([day, v]) => ({ day, ...v })).sort((a, b) =>
    a.day.localeCompare(b.day),
  );
}

/**
 * Format an ISO timestamp as YYYY-MM-DD in a given timezone offset
 * (positive = east of UTC). Hours/Minutes/Seconds are floored.
 */
function isoDateInTz(iso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(iso) + tzOffsetMinutes * 60_000;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Usage estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the *minimum* 积分 a request will consume before it runs.
 * Used by admin UI hints; approximate on purpose.
 *
 * We approximate by counting characters in messages (OpenAI-style:
 roughly 4 chars per token). Not exact but good enough as a UI hint.
 */
export function estimateCredits(args: {
  model: string;
  messages: Array<{ role: string; content: string }>;
}): number {
  const totalChars = args.messages.reduce(
    (sum, m) => sum + (m.content?.length ?? 0),
    0,
  );
  const estInputTokens = Math.ceil(totalChars / 4);
  return computeCredits({
    model: args.model,
    promptTokens: estInputTokens,
    completionTokens: 0,
  });
}
