/**
 * src/lib/db/usage.ts
 *
 * Per-request usage logs and aggregate statistics.
 *
 * Per-log key:
 *   HASH  relay:log:{apiKeyId}:{logId}    → UsageLog fields
 *   LIST  relay:log:by-apikey:{apiKeyId}   → [logId, ...]  (capped at 1000)
 *
 * Aggregate counters are computed by iterating over the LIST and
 * summing fields. For tens of thousands of logs this is still fast
 * (Redis pipelines); beyond that we'd add a HASH hour-counter (v2).
 */
import { UsageLogSchema, type UsageLog, type QuotaType } from "./types";
import { getRedis, k } from "./redis";
import { mapWithConcurrency } from "./concurrency";
import { generateId } from "../crypto/hashing";

/** Max number of log entries kept per API key (older ones trimmed). */
export const MAX_LOGS_PER_KEY = 1000;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RecordUsageInput {
  apiKeyId: string;
  userId: string;
  providerId: string;
  model: string;
  upstreamModel: string;
  promptTokens: number;
  completionTokens: number;
  /** 积分 consumed by this request, in integer 0.001-积分 units. */
  creditsUsed: number;
  status: "success" | "error";
  errorMessage?: string | null;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function recordUsage(input: RecordUsageInput): Promise<UsageLog> {
  const id = generateId();
  const now = new Date().toISOString();
  const totalTokens = input.promptTokens + input.completionTokens;

  const log: UsageLog = UsageLogSchema.parse({
    id,
    apiKeyId: input.apiKeyId,
    userId: input.userId,
    providerId: input.providerId,
    model: input.model,
    upstreamModel: input.upstreamModel,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens,
    creditsUsed: input.creditsUsed,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    createdAt: now,
  });

  const redis = getRedis();
  const tx = redis.multi();
  tx.hset(k.usageLog(log.apiKeyId, log.id), {
    id: log.id,
    apiKeyId: log.apiKeyId,
    userId: log.userId,
    providerId: log.providerId,
    model: log.model,
    upstreamModel: log.upstreamModel,
    promptTokens: String(log.promptTokens),
    completionTokens: String(log.completionTokens),
    totalTokens: String(log.totalTokens),
    creditsUsed: String(log.creditsUsed),
    status: log.status,
    errorMessage: log.errorMessage ?? "",
    createdAt: log.createdAt,
  });
  tx.lpush(k.usageLogsByKey(log.apiKeyId), log.id);
  tx.ltrim(k.usageLogsByKey(log.apiKeyId), 0, MAX_LOGS_PER_KEY - 1);
  // Keep a running total so the dashboard/overview do not have to re-read every
  // log hash to display "tokens used". Same MULTI, so it cannot drift from the
  // log itself. Only successful calls count, matching aggregateLogs().
  if (log.status === "success") {
    const totalsKey = k.usageTotalsByKey(log.apiKeyId);
    tx.hincrby(totalsKey, "promptTokens", log.promptTokens);
    tx.hincrby(totalsKey, "completionTokens", log.completionTokens);
    tx.hincrby(totalsKey, "totalTokens", log.totalTokens);
    tx.hincrby(totalsKey, "creditsUsed", log.creditsUsed);
    tx.hincrby(totalsKey, "requests", 1);
  }
  await tx.exec();

  return log;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Recent N logs for a key (most recent first). */
export async function listUsageByKey(
  apiKeyId: string,
  opts: { limit?: number } = {},
): Promise<UsageLog[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, MAX_LOGS_PER_KEY));
  const redis = getRedis();
  const ids = await redis.lrange(k.usageLogsByKey(apiKeyId), 0, limit - 1);
  // Read the hashes concurrently. Fetching them one-by-one cost a full HTTP
  // round-trip per log (up to MAX_LOGS_PER_KEY of them), which dominated
  // dashboard and usage-page load time on a REST-backed Redis.
  const rows = await mapWithConcurrency(ids, 32, (id) =>
    redis.hgetall<Record<string, string>>(k.usageLog(apiKeyId, id)),
  );
  const parsed = await Promise.all(rows.map((raw) => hashToLog(raw)));
  return parsed.filter((log): log is UsageLog => log !== null);
}

/**
 * Aggregate totals for a key, optionally filtered by date range.
 *
 * @param from  ISO lower bound (inclusive). Defaults to "epoch".
 * @param to    ISO upper bound (exclusive). Defaults to "now+1day".
 */
export async function aggregateByKey(
  apiKeyId: string,
  opts: { from?: string; to?: string } = {},
): Promise<UsageAggregate> {
  // All-time totals come from the running counter (one read). Date-ranged
  // queries still need the individual logs.
  if (!opts.from && !opts.to) {
    const totals = await readKeyTotals(apiKeyId);
    if (totals) return totals;
    // Key whose usage predates the counter: scan once, then backfill so the
    // next load is a single read. (Narrow race: a request recorded while this
    // scan is in flight would be overwritten by the backfill. It only happens
    // on the first read after deployment, and the log itself is untouched.)
    const scanned = aggregateLogs(
      await listUsageByKey(apiKeyId, { limit: MAX_LOGS_PER_KEY }),
      "1970-01-01T00:00:00.000Z",
      "2999-12-31T23:59:59.999Z",
    );
    await writeKeyTotals(apiKeyId, scanned).catch(() => {});
    return scanned;
  }
  const from = opts.from ?? "1970-01-01T00:00:00.000Z";
  const to = opts.to ?? "2999-12-31T23:59:59.999Z";
  return aggregateLogs(await listUsageByKey(apiKeyId, { limit: MAX_LOGS_PER_KEY }), from, to);
}

/**
 * Aggregate totals for a user (across all their keys). Requires the caller
 * to have already enumerated the user's keys.
 */
export async function aggregateByUser(
  apiKeyIds: string[],
  opts: { from?: string; to?: string } = {},
): Promise<UsageAggregate> {
  // Sum the per-key counters instead of re-reading every log hash.
  if (!opts.from && !opts.to) {
    const perKey = await Promise.all(apiKeyIds.map((id) => aggregateByKey(id)));
    return perKey.reduce<UsageAggregate>(
      (acc, x) => ({
        promptTokens: acc.promptTokens + x.promptTokens,
        completionTokens: acc.completionTokens + x.completionTokens,
        totalTokens: acc.totalTokens + x.totalTokens,
        creditsUsed: acc.creditsUsed + x.creditsUsed,
        requestCount: acc.requestCount + x.requestCount,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, creditsUsed: 0, requestCount: 0 },
    );
  }
  const all = await Promise.all(apiKeyIds.map((id) => listUsageByKey(id, { limit: MAX_LOGS_PER_KEY })));
  const flat = all.flat();
  const from = opts.from ?? "1970-01-01T00:00:00.000Z";
  const to = opts.to ?? "2999-12-31T23:59:59.999Z";
  return aggregateLogs(flat, from, to);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageAggregate {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Total 积分 consumed, in integer 0.001-积分 units. */
  creditsUsed: number;
  requestCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashToLog(raw: Record<string, string> | null): Promise<UsageLog | null> {
  if (!raw) return null;
  try {
    return UsageLogSchema.parse({
      id: raw.id,
      apiKeyId: raw.apiKeyId,
      userId: raw.userId,
      providerId: raw.providerId,
      model: raw.model,
      upstreamModel: raw.upstreamModel,
      promptTokens: Number(raw.promptTokens ?? "0"),
      completionTokens: Number(raw.completionTokens ?? "0"),
      totalTokens: Number(raw.totalTokens ?? "0"),
      creditsUsed: Number(raw.creditsUsed ?? "0"),
      status: raw.status,
      errorMessage: raw.errorMessage && raw.errorMessage !== "" ? raw.errorMessage : null,
      createdAt: raw.createdAt,
    });
  } catch {
    return null;
  }
}

function aggregateLogs(
  logs: UsageLog[],
  from: string,
  to: string,
): UsageAggregate {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let creditsUsed = 0;
  let requestCount = 0;

  for (const log of logs) {
    if (log.createdAt < from || log.createdAt >= to) continue;
    if (log.status !== "success") continue;
    promptTokens += log.promptTokens;
    completionTokens += log.completionTokens;
    totalTokens += log.totalTokens;
    creditsUsed += log.creditsUsed;
    requestCount += 1;
  }

  return { promptTokens, completionTokens, totalTokens, creditsUsed, requestCount };
}

/**
 * Read the running totals for a key. Returns null when the counter is absent
 * (a key whose usage predates the counter, or one that was never used) so the
 * caller can fall back to scanning the logs.
 */
async function readKeyTotals(apiKeyId: string): Promise<UsageAggregate | null> {
  const raw = await getRedis().hgetall<Record<string, string>>(
    k.usageTotalsByKey(apiKeyId),
  );
  if (!raw || Object.keys(raw).length === 0) return null;

  const num = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return {
    promptTokens: num(raw.promptTokens),
    completionTokens: num(raw.completionTokens),
    totalTokens: num(raw.totalTokens),
    creditsUsed: num(raw.creditsUsed),
    requestCount: num(raw.requests),
  };
}

/** Persist a scanned aggregate so later reads hit the counter instead. */
async function writeKeyTotals(
  apiKeyId: string,
  totals: UsageAggregate,
): Promise<void> {
  await getRedis().hset(k.usageTotalsByKey(apiKeyId), {
    promptTokens: String(totals.promptTokens),
    completionTokens: String(totals.completionTokens),
    totalTokens: String(totals.totalTokens),
    creditsUsed: String(totals.creditsUsed),
    requests: String(totals.requestCount),
  });
}

// ---------------------------------------------------------------------------
// Quota enforcement helper
// ---------------------------------------------------------------------------

/**
 * After a successful request, decide whether to update quotaUsed.
 * - quotaType=credits: creditsUsed is the delta (units match `quotaUsed`).
 * - quotaType=tokens: totalTokens is the delta.
 *
 * Returns 0 when delta is 0 (e.g. failed requests shouldn't consume quota).
 */
export function quotaDelta(args: {
  quotaType: QuotaType;
  creditsUsed: number;
  totalTokens: number;
}): number {
  return args.quotaType === "credits" ? args.creditsUsed : args.totalTokens;
}
