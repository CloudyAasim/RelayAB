/**
 * src/lib/usage/buckets.ts
 *
 * The same four figures, read from pre-aggregated hours instead of from rows.
 *
 * `usage_logs` is capped per key, so a report that scans it undercounts a busy
 * key in exactly the window where the numbers matter. Every figure below is
 * therefore summed from `usage_buckets`, which is written as traffic happens and
 * is not bounded.
 *
 * The one job of this file is to produce **the same numbers the row-based path
 * produces**, from a different input. That equivalence is what
 * `usage-bucket-equivalence.test.ts` checks, and it is the only reason the two
 * paths can be trusted to agree: anything that changes a figure is a change to
 * the report, not a refactor.
 */
import type { UsageSummary, UsageSeriesPoint, UsageGroupRow, UsageGrain } from "./report";
import { EMPTY_USAGE_SUMMARY } from "./report";

/** What the db layer hands over. Declared here so this file needs no db import. */
export interface BucketRow {
  apiKeyId: string;
  userId: string;
  providerId: string;
  model: string;
  /** UTC hour, `YYYY-MM-DDTHH`. */
  bucket: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  images: number;
  requests: number;
  cachedPromptTokens: number;
  cacheReportedPromptTokens: number;
  cacheReportedRequests: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Add a bucket's ten counters into a summary-shaped accumulator. */
export function addBucket(acc: UsageSummary, row: BucketRow): void {
  acc.requests += row.requests;
  acc.promptTokens += row.promptTokens;
  acc.completionTokens += row.completionTokens;
  acc.totalTokens += row.totalTokens;
  acc.creditsUsed += row.creditsUsed;
  acc.images += row.images;
  acc.cachedPromptTokens += row.cachedPromptTokens;
  acc.cacheReportedPromptTokens += row.cacheReportedPromptTokens;
  acc.cacheReportedRequests += row.cacheReportedRequests;
}

/**
 * The UTC hour a `YYYY-MM-DDTHH` bucket starts at.
 *
 * The stored form is an hour, not an instant, so it has to be completed back
 * into one. Note the seconds: `…T04:00.000Z` is not a valid ISO instant and
 * parses as NaN, which is a silent way to lose every date on a chart.
 */
function hourStartMs(bucket: string): number {
  const ms = Date.parse(`${bucket}:00:00.000Z`);
  if (!Number.isFinite(ms)) {
    throw new Error(`not a usable UTC hour bucket: ${JSON.stringify(bucket)}`);
  }
  return ms;
}

/**
 * The reader's own bucket for a stored hour.
 *
 * Both display zones are whole hours (UTC+0 and UTC+8), so a reader's hour is
 * exactly one stored hour shifted by a whole number of hours — and a day is
 * exactly 24 of them. Both facts are load-bearing: a half-hour zone would make
 * this a split rather than a rename, which is why `utcHourOf` is where that
 * change would have to start.
 */
function localBucketOf(row: BucketRow, grain: UsageGrain, tzOffsetMinutes: number): string {
  const d = new Date(hourStartMs(row.bucket) + tzOffsetMinutes * 60_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  if (grain === "day") return `${y}-${mo}-${da}`;
  return `${y}-${mo}-${da}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

/** Total across every bucket. */
export function summarizeBuckets(rows: readonly BucketRow[]): UsageSummary {
  const acc = { ...EMPTY_USAGE_SUMMARY };
  for (const row of rows) addBucket(acc, row);
  return acc;
}

/** One point per reader-facing bucket, hour rows summed into day buckets. */
export function seriesFromBuckets(
  rows: readonly BucketRow[],
  grain: UsageGrain,
  tzOffsetMinutes: number,
): UsageSeriesPoint[] {
  const buckets = new Map<string, UsageSeriesPoint>();
  for (const row of rows) {
    const bucket = localBucketOf(row, grain, tzOffsetMinutes);
    const cur =
      buckets.get(bucket) ?? {
        bucket,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        images: 0,
        cachedPromptTokens: 0,
        cacheReportedPromptTokens: 0,
        cacheReportedRequests: 0,
      };
    cur.requests += row.requests;
    cur.promptTokens += row.promptTokens;
    cur.completionTokens += row.completionTokens;
    cur.totalTokens += row.totalTokens;
    cur.creditsUsed += row.creditsUsed;
    cur.images += row.images;
    cur.cachedPromptTokens += row.cachedPromptTokens;
    cur.cacheReportedPromptTokens += row.cacheReportedPromptTokens;
    cur.cacheReportedRequests += row.cacheReportedRequests;
    buckets.set(bucket, cur);
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Which grouping each breakdown column reads off a bucket row. */
const GROUP_FIELD = {
  apiKeyId: "apiKeyId",
  userId: "userId",
  model: "model",
  providerId: "providerId",
} as const;

export type BucketGroupField = keyof typeof GROUP_FIELD;

/** Rows grouped the way `report.group` groups logs, biggest spenders first. */
export function groupBuckets(
  rows: readonly BucketRow[],
  field: BucketGroupField,
): UsageGroupRow[] {
  const groups = new Map<string, UsageGroupRow>();
  for (const row of rows) {
    const id = row[GROUP_FIELD[field]];
    const cur = groups.get(id) ?? { id, ...EMPTY_USAGE_SUMMARY };
    addBucket(cur, row);
    groups.set(id, cur);
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.creditsUsed - a.creditsUsed ||
      b.totalTokens - a.totalTokens ||
      a.id.localeCompare(b.id),
  );
}

/** Exported for the retention window, which is a day count on the same clock. */
export const BUCKET_HOUR_MS = HOUR_MS;
export const BUCKET_DAY_MS = DAY_MS;