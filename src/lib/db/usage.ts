/**
 * src/lib/db/usage.ts
 *
 * Per-request usage logs and aggregate statistics.
 *
 * Schema:
 *   TABLE usage_logs       → one row per request
 *   TABLE usage_totals     → running per-key counters
 *
 * This is where SQLite pays for itself. The Redis version had to SCAN the key
 * space, hydrate every log hash in pipelined batches, and sum the fields in
 * JavaScript — and it still kept a separate running-counter hash so the common
 * "all-time totals" read stayed O(1). A date-ranged aggregate had no such
 * shortcut and fell back to the full scan.
 *
 * Here both paths are single queries: `SUM(...) ... GROUP BY` for the ranged
 * case, and the `usage_totals` row for the all-time case. The counters stay
 * because the proxy reads them on every request; they are written in the same
 * transaction as the log, so they cannot drift.
 */
import { UsageLogSchema, type UsageLog, type QuotaType } from "./types";
import { getAll, getDb, getOne, rowToUsageLog, run, withTransaction } from "./sqlite";
import { generateId } from "../crypto/hashing";

/**
 * Max number of log entries kept per API key (older ones trimmed).
 *
 * Retained as a cap on the per-key log history. It used to be enforced with
 * LTRIM on a LIST; now it is a DELETE of everything past the newest N rows.
 */
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
  /** Media items produced (images/videos/…); 0 for chat calls. */
  images?: number;
  /** Media capability that produced this row, when applicable. */
  capability?: string;
  status: "success" | "error";
  errorMessage?: string | null;
  /**
   * How the token counts were obtained. Defaults to "usage" for non-streaming
   * callers; streaming proxies set "estimated" when the upstream never sent
   * a usage frame.
   */
  billingMode?: "usage" | "estimated";
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
    images: input.images ?? 0,
    capability: input.capability,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    billingMode: input.billingMode ?? "usage",
    createdAt: now,
  });

  // The log, the running counters and the trim are one unit of work: a
  // crash must not leave a billed request unrecorded, or a counter that
  // disagrees with the log it summarises.
  await withTransaction(() => {
    run(
      `INSERT INTO usage_logs
         (id, api_key_id, user_id, provider_id, model, upstream_model,
          prompt_tokens, completion_tokens, total_tokens, credits_used,
          images, capability, status, error_message, billing_mode, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        log.id,
        log.apiKeyId,
        log.userId,
        log.providerId,
        log.model,
        log.upstreamModel,
        log.promptTokens,
        log.completionTokens,
        log.totalTokens,
        log.creditsUsed,
        log.images ?? 0,
        log.capability ?? null,
        log.status,
        log.errorMessage ?? null,
        log.billingMode ?? "usage",
        log.createdAt,
      ],
    );

    // Only successful calls count toward totals, matching aggregate().
    if (log.status === "success") {
      run(
        `INSERT INTO usage_totals
           (api_key_id, prompt_tokens, completion_tokens, total_tokens, credits_used, images, requests)
         VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(api_key_id) DO UPDATE SET
           prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           total_tokens      = total_tokens + excluded.total_tokens,
           credits_used      = credits_used + excluded.credits_used,
           images            = images + excluded.images,
           requests          = requests + 1`,
        [
          log.apiKeyId,
          log.promptTokens,
          log.completionTokens,
          log.totalTokens,
          log.creditsUsed,
          log.images ?? 0,
        ],
      );
    }

    // Trim oldest rows beyond the cap. The subquery keeps the newest N by
    // created_at (id breaks ties for rows logged in the same millisecond).
    run(
      `DELETE FROM usage_logs WHERE api_key_id = ? AND id NOT IN (
         SELECT id FROM usage_logs WHERE api_key_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
      [log.apiKeyId, log.apiKeyId, MAX_LOGS_PER_KEY],
    );
  });

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
  return getAll(
    "SELECT * FROM usage_logs WHERE api_key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    [apiKeyId, limit],
    rowToUsageLog,
  );
}

/**
 * Logs for a key that fall at or after `fromIso`, read newest-first.
 *
 * The Redis version paged through a LIST and stopped once a page's oldest row
 * predated the window. That is a server-side comparison here, so the whole
 * range filter is a single indexed query.
 *
 * With no `fromIso` this is equivalent to `listUsageByKey(..., { limit: max })`.
 */
export async function listUsageWithin(
  apiKeyId: string,
  opts: { fromIso?: string; max?: number } = {},
): Promise<UsageLog[]> {
  const max = Math.max(1, Math.min(opts.max ?? MAX_LOGS_PER_KEY, MAX_LOGS_PER_KEY));
  if (!opts.fromIso) return listUsageByKey(apiKeyId, { limit: max });

  return getAll(
    `SELECT * FROM usage_logs
      WHERE api_key_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [apiKeyId, opts.fromIso, max],
    rowToUsageLog,
  );
}

/**
 * Most recent usage rows across several keys, newest first.
 *
 * One query for the whole set. The Redis version fanned out with a bounded
 * concurrency pool and merge-sorted the per-key pages in JavaScript.
 */
export async function listRecentUsage(
  apiKeyIds: readonly string[],
  opts: { limit?: number } = {},
): Promise<UsageLog[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  if (apiKeyIds.length === 0) return [];

  // Chunked to stay under SQLite's bound-parameter limit (999 by default) on
  // a user with a lot of keys.
  const rows: UsageLog[] = [];
  const CHUNK = 500;
  for (let i = 0; i < apiKeyIds.length; i += CHUNK) {
    const slice = apiKeyIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    rows.push(
      ...getAll(
        `SELECT * FROM usage_logs WHERE api_key_id IN (${placeholders})
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...slice, limit],
        rowToUsageLog,
      ),
    );
  }

  return rows
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/**
 * Aggregate totals for many keys at once.
 *
 * Reads the running counters in one query. Keys with no counter row (never
 * used, or predating it) are backfilled from their logs so the next load is a
 * single read again — the same self-healing behaviour as the Redis version.
 */
export async function aggregateByKeyMany(
  apiKeyIds: readonly string[],
): Promise<UsageAggregate[]> {
  if (apiKeyIds.length === 0) return [];

  const totals = readKeyTotalsMany(apiKeyIds);
  const out = new Array<UsageAggregate>(apiKeyIds.length);
  const missing: number[] = [];
  totals.forEach((totalsForKey, index) => {
    if (totalsForKey) out[index] = totalsForKey;
    else missing.push(index);
  });

  if (missing.length > 0) {
    const filled = await Promise.all(missing.map((index) => aggregateByKey(apiKeyIds[index])));
    missing.forEach((index, n) => {
      out[index] = filled[n];
    });
  }

  return out;
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
  // All-time totals come from the running counter (one indexed row read).
  if (!opts.from && !opts.to) {
    const totals = readKeyTotals(apiKeyId);
    if (totals) return totals;
    // Never-used key, or one whose usage predates the counter. Aggregating its
    // logs is cheap here (a single indexed scan), so unlike the Redis version
    // there is no need to backfill the counter — the next call recomputes the
    // same answer from the same rows.
    return aggregateByKeyRange(apiKeyId, EPOCH, FAR_FUTURE);
  }
  return aggregateByKeyRange(
    apiKeyId,
    opts.from ?? EPOCH,
    opts.to ?? FAR_FUTURE,
  );
}

/**
 * Aggregate totals for a user (across all their keys). Requires the caller
 * to have already enumerated the user's keys.
 */
export async function aggregateByUser(
  apiKeyIds: string[],
  opts: { from?: string; to?: string } = {},
): Promise<UsageAggregate> {
  if (apiKeyIds.length === 0) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      creditsUsed: 0,
      images: 0,
      requestCount: 0,
    };
  }

  // Unranged: sum the counters rather than re-reading every log.
  if (!opts.from && !opts.to) {
    const perKey = await aggregateByKeyMany(apiKeyIds);
    return perKey.reduce<UsageAggregate>(
      (acc, x) => ({
        promptTokens: acc.promptTokens + x.promptTokens,
        completionTokens: acc.completionTokens + x.completionTokens,
        totalTokens: acc.totalTokens + x.totalTokens,
        creditsUsed: acc.creditsUsed + x.creditsUsed,
        images: acc.images + x.images,
        requestCount: acc.requestCount + x.requestCount,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, creditsUsed: 0, images: 0, requestCount: 0 },
    );
  }

  const from = opts.from ?? EPOCH;
  const to = opts.to ?? FAR_FUTURE;

  // Ranged: one GROUP BY over all the user's keys. This replaces the Redis
  // version's fan-out-then-flatten-then-sum-in-JS.
  const CHUNK = 500;
  const acc: UsageAggregate = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    creditsUsed: 0,
    images: 0,
    requestCount: 0,
  };
  for (let i = 0; i < apiKeyIds.length; i += CHUNK) {
    const slice = apiKeyIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    for (const row of getAll<RawAggregate>(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
         COALESCE(SUM(completion_tokens), 0) AS completionTokens,
         COALESCE(SUM(total_tokens), 0)      AS totalTokens,
         COALESCE(SUM(credits_used), 0)      AS creditsUsed,
         COALESCE(SUM(images), 0)           AS images,
         COUNT(*)                          AS requestCount
       FROM usage_logs
       WHERE status = 'success'
         AND created_at >= ? AND created_at < ?
         AND api_key_id IN (${placeholders})`,
      [from, to, ...slice],
      (r) => r as unknown as RawAggregate,
    )) {
      acc.promptTokens += num(row.promptTokens);
      acc.completionTokens += num(row.completionTokens);
      acc.totalTokens += num(row.totalTokens);
      acc.creditsUsed += num(row.creditsUsed);
      acc.images += num(row.images);
      acc.requestCount += num(row.requestCount);
    }
  }
  return acc;
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
  /** Media items produced; 0 for chat-only traffic. */
  images: number;
  requestCount: number;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-12-31T23:59:59.999Z";

interface RawAggregate {
  promptTokens: unknown;
  completionTokens: unknown;
  totalTokens: unknown;
  creditsUsed: unknown;
  images: unknown;
  requestCount: unknown;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ranged aggregate for a single key, computed in SQL.
 *
 * Only successful rows count, matching the running counter and the Redis
 * version's `aggregateLogs`. The `created_at` range is a string comparison,
 * which is correct because timestamps are stored as ISO-8601 and ISO strings
 * sort chronologically.
 */
function aggregateByKeyRange(
  apiKeyId: string,
  from: string,
  to: string,
): UsageAggregate {
  const row = getOne<RawAggregate>(
    `SELECT
       COALESCE(SUM(prompt_tokens), 0)     AS promptTokens,
       COALESCE(SUM(completion_tokens), 0) AS completionTokens,
       COALESCE(SUM(total_tokens), 0)      AS totalTokens,
       COALESCE(SUM(credits_used), 0)      AS creditsUsed,
       COALESCE(SUM(images), 0)           AS images,
       COUNT(*)                          AS requestCount
     FROM usage_logs
     WHERE api_key_id = ? AND status = 'success'
       AND created_at >= ? AND created_at < ?`,
    [apiKeyId, from, to],
    (r) => r as unknown as RawAggregate,
  );
  if (!row) {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      creditsUsed: 0,
      images: 0,
      requestCount: 0,
    };
  }
  return {
    promptTokens: num(row.promptTokens),
    completionTokens: num(row.completionTokens),
    totalTokens: num(row.totalTokens),
    creditsUsed: num(row.creditsUsed),
    images: num(row.images),
    requestCount: num(row.requestCount),
  };
}

/**
 * Read the running totals for a key. Returns null when the counter is absent
 * (a key that has never been used) so the caller can aggregate its logs.
 */
function readKeyTotals(apiKeyId: string): UsageAggregate | null {
  const row = getOne<Record<string, unknown>>(
    "SELECT * FROM usage_totals WHERE api_key_id = ?",
    [apiKeyId],
  );
  return row ? parseKeyTotals(row) : null;
}

/**
 * Read the running totals for many keys in one query.
 * Entries are `null` where the key has no counter yet.
 */
function readKeyTotalsMany(
  apiKeyIds: readonly string[],
): Array<UsageAggregate | null> {
  if (apiKeyIds.length === 0) return [];

  // Chunked to stay under SQLite's bound-parameter limit.
  const byId = new Map<string, UsageAggregate>();
  const CHUNK = 500;
  for (let i = 0; i < apiKeyIds.length; i += CHUNK) {
    const slice = apiKeyIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    for (const row of getAll<Record<string, unknown>>(
      `SELECT * FROM usage_totals WHERE api_key_id IN (${placeholders})`,
      slice,
      (r) => r,
    )) {
      byId.set(String(row.api_key_id), parseKeyTotals(row)!);
    }
  }
  return apiKeyIds.map((id) => byId.get(id) ?? null);
}

function parseKeyTotals(row: Record<string, unknown>): UsageAggregate {
  return {
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    creditsUsed: num(row.credits_used),
    images: num(row.images),
    requestCount: num(row.requests),
  };
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

// Referenced so bundlers that tree-shake per-export do not drop the
// connection module when only the helpers above are used.
void getDb;
