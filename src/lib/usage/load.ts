/**
 * src/lib/usage/load.ts
 *
 * Server-side orchestration for the usage screens/APIs: read the hourly
 * pre-aggregation, and hand what it cannot answer to the pure aggregator in
 * ./report.
 *
 * Two performance properties matter here:
 *
 *  1. Bounded reads. Range figures are summed from `usage_buckets`, so a window
 *     costs the same whether the key made ten requests in it or ten million.
 *     The row scan that `listUsageWithin` performs is the fallback, not the
 *     normal path, and is bounded by the window's lower bound when it runs.
 *  2. A short data cache. `loadUsageReportCached` memoises the report for
 *     `REPORT_REVALIDATE_SECONDS`, which makes switching back and forth between
 *     ranges (and refresh) cheap. Usage is append-only and the UI already warns
 *     that figures can lag, so a 30s cache changes no user-visible semantics
 *     except freshness.
 *
 * "All time" totals come from the running per-key counters (accurate even when
 * a key has more than `MAX_LOGS_PER_KEY` retained rows). Range and breakdown
 * figures come from `usage_buckets`, the hourly pre-aggregation written as
 * traffic happens, so they are bounded by time rather than by how many rows
 * happen to be retained.
 *
 * A window that predates the buckets — or one in a deployment where the
 * backfill never ran — falls back to scanning the rows, which is the old
 * behaviour, truncated and flagged. That fallback is why `truncatedKeys` is
 * still computed and still shown: it is true of the fallback, and false of the
 * path that is normally taken.
 */
import { unstable_cache } from "next/cache";
import { mapWithConcurrency } from "@/lib/db/concurrency";
import {
  MAX_LOGS_PER_KEY,
  aggregateByKeyMany,
  listUsageBuckets,
  listUsageByKey,
  listUsageWithin,
} from "@/lib/db/usage";
import {
  EMPTY_USAGE_SUMMARY,
  fillSeries,
  group,
  series,
  summarize,
  type UsageGroupRow,
  type UsageRange,
  type UsageSeriesPoint,
  type UsageSummary,
} from "./report";
import {
  groupBuckets,
  seriesFromBuckets,
  summarizeBuckets,
} from "./buckets";

export interface UsageReport {
  range: UsageRange;
  summary: UsageSummary;
  series: UsageSeriesPoint[];
  byKey: UsageGroupRow[];
  byModel: UsageGroupRow[];
  byProvider: UsageGroupRow[];
  byUser: UsageGroupRow[];
  /** Keys whose retained log window was full, so range figures may undercount. */
  truncatedKeys: number;
}

export interface LoadUsageReportInput {
  keyIds: readonly string[];
  tzOffsetMinutes: number;
  range: UsageRange;
  /** Restrict to a single client model (the "指定模型" scope). */
  model?: string;
  /** Include the per-user breakdown (admin only). */
  includeUsers?: boolean;
}

const SCAN_CONCURRENCY = 8;

/** How long a computed report stays warm in the Next data cache. */
const REPORT_REVALIDATE_SECONDS = 30;

export async function loadUsageReport(
  input: LoadUsageReportInput,
): Promise<UsageReport> {
  const { keyIds, tzOffsetMinutes, range } = input;

  /**
   * The pre-aggregated path first. Everything it cannot answer — a window with
   * no buckets in it — falls through to the rows, which is the old behaviour
   * and the reason the truncation warning still exists at all.
   */
  const bucketRows = (
    await listUsageBuckets(keyIds, {
      ...(range.fromIso ? { fromIso: range.fromIso } : {}),
      ...(range.toIso ? { toIso: range.toIso } : {}),
    })
  ).filter((row) => (input.model ? row.model === input.model : true));

  if (bucketRows.length > 0) {
    // "All time" totals are lifetime, from the running counters; the series and
    // the breakdowns below cover the bucket retention window. The two have
    // always been able to disagree — they were previously bounded by how many
    // rows survived, now by how many hours were kept — and a bounded chart
    // under a lifetime number is the same claim as ever, not a new one.
    const summary =
      range.key === "all" && !input.model
        ? await sumAllTime(keyIds)
        : summarizeBuckets(bucketRows);
    return {
      range,
      summary,
      series: fillSeries(
        seriesFromBuckets(bucketRows, range.grain, tzOffsetMinutes),
        range,
        tzOffsetMinutes,
      ),
      byKey: groupBuckets(bucketRows, "apiKeyId"),
      byModel: groupBuckets(bucketRows, "model"),
      byProvider: groupBuckets(bucketRows, "providerId"),
      byUser: input.includeUsers ? groupBuckets(bucketRows, "userId") : [],
      // Nothing was cut: these figures were summed as the traffic arrived.
      truncatedKeys: 0,
    };
  }

  const perKey = await mapWithConcurrency(keyIds, SCAN_CONCURRENCY, (keyId) =>
    range.fromIso
      ? listUsageWithin(keyId, { fromIso: range.fromIso, max: MAX_LOGS_PER_KEY })
      : listUsageByKey(keyId, { limit: MAX_LOGS_PER_KEY }),
  );
  const rawLogs = perKey.flat();
  const logs = input.model
    ? rawLogs.filter((log) => log.model === input.model)
    : rawLogs;
  const truncatedKeys = perKey.filter((rows) => rows.length >= MAX_LOGS_PER_KEY).length;

  const summary =
    range.key === "all" && !input.model
      ? await sumAllTime(keyIds)
      : summarize(logs, range.fromIso, range.toIso);

  return {
    range,
    summary,
    series: fillSeries(
      series(logs, range.grain, tzOffsetMinutes, range.fromIso, range.toIso),
      range,
      tzOffsetMinutes,
    ),
    byKey: group(logs, "apiKeyId", range.fromIso, range.toIso),
    byModel: group(logs, "model", range.fromIso, range.toIso),
    byProvider: group(logs, "providerId", range.fromIso, range.toIso),
    byUser: input.includeUsers ? group(logs, "userId", range.fromIso, range.toIso) : [],
    truncatedKeys,
  };
}

/**
 * Cached wrapper used by the pages and routes. Ids are sorted so the cache key
 * is stable regardless of how the caller enumerated the keys.
 */
export async function loadUsageReportCached(
  input: LoadUsageReportInput,
): Promise<UsageReport> {
  const ids = [...input.keyIds].sort();
  return cachedReport(
    ids.join(","),
    input.tzOffsetMinutes,
    input.range,
    input.model ?? "",
    input.includeUsers ?? false,
  );
}

const cachedReport = unstable_cache(
  async (
    keyIdsCsv: string,
    tzOffsetMinutes: number,
    range: UsageRange,
    model: string,
    includeUsers: boolean,
  ): Promise<UsageReport> =>
    loadUsageReport({
      keyIds: keyIdsCsv ? keyIdsCsv.split(",") : [],
      tzOffsetMinutes,
      range,
      model: model || undefined,
      includeUsers,
    }),
  ["usage-report"],
  { revalidate: REPORT_REVALIDATE_SECONDS },
);

/** Lifetime totals from the running per-key counters. */
export async function sumAllTime(keyIds: readonly string[]): Promise<UsageSummary> {
  if (keyIds.length === 0) return { ...EMPTY_USAGE_SUMMARY };
  const perKey = await aggregateByKeyMany(keyIds);
  return perKey.reduce<UsageSummary>(
    (acc, totals) => ({
      requests: acc.requests + totals.requestCount,
      promptTokens: acc.promptTokens + totals.promptTokens,
      completionTokens: acc.completionTokens + totals.completionTokens,
      totalTokens: acc.totalTokens + totals.totalTokens,
      creditsUsed: acc.creditsUsed + totals.creditsUsed,
      images: acc.images + totals.images,
      cachedPromptTokens: acc.cachedPromptTokens + totals.cachedPromptTokens,
      cacheReportedPromptTokens: acc.cacheReportedPromptTokens + totals.cacheReportedPromptTokens,
      cacheReportedRequests: acc.cacheReportedRequests + totals.cacheReportedRequests,
    }),
    { ...EMPTY_USAGE_SUMMARY },
  );
}

/** Cached lifetime totals (same 30s window as the report cache). */
export async function sumAllTimeCached(
  keyIds: readonly string[],
): Promise<UsageSummary> {
  return cachedSumAllTime([...keyIds].sort().join(","));
}

const cachedSumAllTime = unstable_cache(
  async (keyIdsCsv: string): Promise<UsageSummary> =>
    sumAllTime(keyIdsCsv ? keyIdsCsv.split(",") : []),
  ["usage-lifetime"],
  { revalidate: REPORT_REVALIDATE_SECONDS },
);
