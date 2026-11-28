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
 *
 * The report also carries `source`, because the two paths look identical from
 * the outside and one of them cannot see past the per-key row cap. A screen
 * that shows a fallback figure without saying so turns "the rows were pruned"
 * into "nothing happened", which is the more dangerous of the two errors.
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
import { isWebSearchUsage } from "../search/usage";

/**
 * Web search, as a **subset** of the report above.
 *
 * Search rows are already inside `summary`, `series` and every breakdown —
 * `recordUsage` writes them like any other request. This view exists so an
 * operator can see how much of the total is search; it must never be added to
 * the totals, and no page renders it as an extra breakdown row.
 */
export interface UsageWebSearchReport {
  summary: UsageSummary;
  series: UsageSeriesPoint[];
  byProvider: UsageGroupRow[];
}

/**
 * Where the figures came from.
 *
 * The two paths do not answer the same question. `buckets` is the kept record —
 * one row per key/provider/model/hour, summed as the traffic arrived. The
 * log fallback reads rows that are capped per key, so within a range its
 * numbers are what survived the cap, not what happened. A page that prints
 * either without saying which is printing a smaller number as if it were the
 * whole number, which is exactly what the empty chart looked like from the
 * outside: correct arithmetic over the wrong set.
 */
export type UsageReportSource = "buckets" | "retained-logs";

export interface UsageReport {
  range: UsageRange;
  summary: UsageSummary;
  series: UsageSeriesPoint[];
  byKey: UsageGroupRow[];
  byModel: UsageGroupRow[];
  byProvider: UsageGroupRow[];
  byUser: UsageGroupRow[];
  /** A filtered view of the figures above, never an addition to them. */
  webSearch: UsageWebSearchReport;
  /** Which of the two paths produced the range figures above. */
  source: UsageReportSource;
  /**
   * Keys whose retained log window was full, so range figures may undercount.
   * Always 0 on the `buckets` path; on `retained-logs` it is a floor, not a
   * count — a key can have lost rows without its window still being full.
   */
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
    // the breakdowns below come from the buckets, which are never pruned. The
    // two still disagree in one case: a deployment whose buckets were pruned
    // before this change. A chart under a lifetime number is the same claim as
    // ever, not a new one — and the missing hours cannot be re-derived from
    // rows that are already gone.
    const summary =
      range.key === "all" && !input.model
        ? await sumAllTime(keyIds)
        : summarizeBuckets(bucketRows);
    const searchRows = bucketRows.filter(isWebSearchUsage);
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
      webSearch: {
        summary: summarizeBuckets(searchRows),
        series: fillSeries(
          seriesFromBuckets(searchRows, range.grain, tzOffsetMinutes),
          range,
          tzOffsetMinutes,
        ),
        byProvider: groupBuckets(searchRows, "providerId"),
      },
      // Nothing was cut: these figures were summed as the traffic arrived.
      source: "buckets",
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

  const searchLogs = logs.filter(isWebSearchUsage);
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
    webSearch: {
      summary: summarize(searchLogs, range.fromIso, range.toIso),
      series: fillSeries(
        series(searchLogs, range.grain, tzOffsetMinutes, range.fromIso, range.toIso),
        range,
        tzOffsetMinutes,
      ),
      byProvider: group(searchLogs, "providerId", range.fromIso, range.toIso),
    },
    // The kept record was empty for this window, so these figures are a
    // survival count. Say so out loud: the caller cannot tell a quiet week from
    // a pruned one by looking at the numbers.
    source: "retained-logs",
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
