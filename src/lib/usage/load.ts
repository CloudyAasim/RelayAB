/**
 * src/lib/usage/load.ts
 *
 * Server-side orchestration for the usage screens/APIs: fetch the retained
 * per-key logs, then hand them to the pure aggregator in ./report.
 *
 * "All time" totals come from the running per-key counters (accurate even when
 * a key has more than `MAX_LOGS_PER_KEY` retained rows). Range and breakdown
 * figures scan the retained logs, so a very busy key can undercount inside a
 * window; `truncatedKeys` tells the UI when that may be the case.
 */
import { mapWithConcurrency } from "@/lib/db/concurrency";
import {
  MAX_LOGS_PER_KEY,
  aggregateByKeyMany,
  listUsageByKey,
} from "@/lib/db/usage";
import type { ApiKey } from "@/lib/db/types";
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
  logCount: number;
}

export interface LoadUsageReportInput {
  keys: readonly ApiKey[];
  tzOffsetMinutes: number;
  range: UsageRange;
  /** Include the per-user breakdown (admin only). */
  includeUsers?: boolean;
}

const SCAN_CONCURRENCY = 8;

export async function loadUsageReport(
  input: LoadUsageReportInput,
): Promise<UsageReport> {
  const { keys, tzOffsetMinutes, range } = input;
  const perKey = await mapWithConcurrency(keys, SCAN_CONCURRENCY, (key) =>
    listUsageByKey(key.id, { limit: MAX_LOGS_PER_KEY }),
  );
  const logs = perKey.flat();
  const truncatedKeys = perKey.filter((rows) => rows.length >= MAX_LOGS_PER_KEY).length;

  const summary =
    range.key === "all" ? await sumAllTime(keys) : summarize(logs, range.fromIso, range.toIso);

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
    logCount: logs.length,
  };
}

/** Lifetime totals from the running per-key counters. */
export async function sumAllTime(keys: readonly ApiKey[]): Promise<UsageSummary> {
  if (keys.length === 0) return { ...EMPTY_USAGE_SUMMARY };
  const perKey = await aggregateByKeyMany(keys.map((key) => key.id));
  return perKey.reduce<UsageSummary>(
    (acc, totals) => ({
      requests: acc.requests + totals.requestCount,
      promptTokens: acc.promptTokens + totals.promptTokens,
      completionTokens: acc.completionTokens + totals.completionTokens,
      totalTokens: acc.totalTokens + totals.totalTokens,
      creditsUsed: acc.creditsUsed + totals.creditsUsed,
    }),
    { ...EMPTY_USAGE_SUMMARY },
  );
}
