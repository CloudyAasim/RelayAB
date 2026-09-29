/**
 * src/lib/usage/report.ts
 *
 * Pure aggregation for the usage screens and the usage APIs.
 *
 * The storage layer keeps at most `MAX_LOGS_PER_KEY` per-request rows per key,
 * newest first (see `lib/db/usage.ts`). Range queries therefore scan the
 * retained logs and bucket them in memory; the running per-key counters stay
 * the source of truth for lifetime totals. Everything here is pure, so it can
 * be unit-tested without Redis or a real clock.
 *
 * Timezone: every displayed date is bucketed in the report timezone. The
 * screens default to GMT+8 (offset +480 minutes), matching the product's
 * primary audience; the offset is a parameter everywhere so it stays testable
 * and overrideable.
 */
import type { UsageLog } from "@/lib/db/types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export type UsageGrain = "hour" | "day";
export type UsageGroupField = "apiKeyId" | "userId" | "model" | "providerId";

export interface UsageSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  /** Media items produced (images, videos, …); 0 for chat-only traffic. */
  images: number;
}

export interface UsageSeriesPoint {
  /** "YYYY-MM-DD" (day) or "YYYY-MM-DDTHH" (hour), in the report timezone. */
  bucket: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsUsed: number;
  images: number;
}

export interface UsageGroupRow extends UsageSummary {
  id: string;
}

export const EMPTY_USAGE_SUMMARY: UsageSummary = {
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  creditsUsed: 0,
  images: 0,
};

export function addSummary(target: UsageSummary, log: UsageLog): void {
  if (log.status !== "success") return;
  target.requests += 1;
  target.promptTokens += log.promptTokens;
  target.completionTokens += log.completionTokens;
  target.totalTokens += log.totalTokens;
  target.creditsUsed += log.creditsUsed;
  target.images += log.images ?? 0;
}

export function sumSummaries(summaries: readonly UsageSummary[]): UsageSummary {
  const acc = { ...EMPTY_USAGE_SUMMARY };
  for (const s of summaries) {
    acc.requests += s.requests;
    acc.promptTokens += s.promptTokens;
    acc.completionTokens += s.completionTokens;
    acc.totalTokens += s.totalTokens;
    acc.creditsUsed += s.creditsUsed;
    acc.images += s.images;
  }
  return acc;
}

export function isWithinRange(
  log: UsageLog,
  fromIso?: string,
  toIso?: string,
): boolean {
  if (fromIso && log.createdAt < fromIso) return false;
  if (toIso && log.createdAt >= toIso) return false;
  return true;
}

/** Totals over the given window. Failed requests never count. */
export function summarize(
  logs: readonly UsageLog[],
  fromIso?: string,
  toIso?: string,
): UsageSummary {
  const acc = { ...EMPTY_USAGE_SUMMARY };
  for (const log of logs) {
    if (!isWithinRange(log, fromIso, toIso)) continue;
    addSummary(acc, log);
  }
  return acc;
}

/** Local wall-clock bucket id for an instant. */
export function bucketOf(
  iso: string,
  grain: UsageGrain,
  tzOffsetMinutes: number,
): string {
  return formatLocalBucket(Date.parse(iso) + tzOffsetMinutes * MINUTE_MS, grain);
}

function formatLocalBucket(localMs: number, grain: UsageGrain): string {
  const d = new Date(localMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  if (grain === "day") return `${y}-${mo}-${da}`;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${da}T${hh}`;
}

/** Ascending non-empty buckets over the window. */
export function series(
  logs: readonly UsageLog[],
  grain: UsageGrain,
  tzOffsetMinutes: number,
  fromIso?: string,
  toIso?: string,
): UsageSeriesPoint[] {
  const buckets = new Map<string, UsageSeriesPoint>();
  for (const log of logs) {
    if (!isWithinRange(log, fromIso, toIso)) continue;
    if (log.status !== "success") continue;
    const bucket = bucketOf(log.createdAt, grain, tzOffsetMinutes);
    const cur =
      buckets.get(bucket) ?? {
        bucket,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        images: 0,
      };
    cur.requests += 1;
    cur.promptTokens += log.promptTokens;
    cur.completionTokens += log.completionTokens;
    cur.totalTokens += log.totalTokens;
    cur.creditsUsed += log.creditsUsed;
    cur.images += log.images ?? 0;
    buckets.set(bucket, cur);
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/** Group rows, biggest spenders first. */
export function group(
  logs: readonly UsageLog[],
  field: UsageGroupField,
  fromIso?: string,
  toIso?: string,
): UsageGroupRow[] {
  const rows = new Map<string, UsageGroupRow>();
  for (const log of logs) {
    if (!isWithinRange(log, fromIso, toIso)) continue;
    if (log.status !== "success") continue;
    const id = log[field];
    const cur = rows.get(id) ?? { id, ...EMPTY_USAGE_SUMMARY };
    addSummary(cur, log);
    rows.set(id, cur);
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.creditsUsed - a.creditsUsed ||
      b.totalTokens - a.totalTokens ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Metrics (which number the chart / table is ranked by)
// ---------------------------------------------------------------------------

export type UsageMetric = "credits" | "tokens" | "requests";

export function parseUsageMetric(
  value: string | null | undefined,
  fallback: UsageMetric = "credits",
): UsageMetric {
  return value === "credits" || value === "tokens" || value === "requests"
    ? value
    : fallback;
}

export function metricValue(
  row: { creditsUsed: number; totalTokens: number; requests: number },
  metric: UsageMetric,
): number {
  if (metric === "credits") return row.creditsUsed;
  if (metric === "tokens") return row.totalTokens;
  return row.requests;
}

/** Copy of `rows`, ranked by the selected metric (desc), id as tie-break. */
export function sortByMetric<
  T extends { id: string; creditsUsed: number; totalTokens: number; requests: number },
>(rows: readonly T[], metric: UsageMetric): T[] {
  return [...rows].sort(
    (a, b) => metricValue(b, metric) - metricValue(a, metric) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

export type UsageRangeKey = "today" | "7d" | "30d" | "90d" | "all" | "custom";

export interface UsageRange {
  key: UsageRangeKey;
  /** ISO lower bound (inclusive); undefined = open lower bound. */
  fromIso?: string;
  /** ISO upper bound (exclusive); undefined = open upper bound. */
  toIso?: string;
  grain: UsageGrain;
}

export interface ResolveRangeInput {
  key?: string | null;
  /** Inclusive local date "YYYY-MM-DD" for a custom range. */
  from?: string | null;
  /** Inclusive local date "YYYY-MM-DD" for a custom range. */
  to?: string | null;
  tzOffsetMinutes: number;
  now?: Date;
}

const PRESET_DAYS: Record<"7d" | "30d" | "90d", number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export const DEFAULT_RANGE_KEY: UsageRangeKey = "7d";

export function resolveRange(input: ResolveRangeInput): UsageRange {
  const tz = input.tzOffsetMinutes;
  const nowMs = (input.now ?? new Date()).getTime();
  const key = normalizeRangeKey(input.key, input.from, input.to);

  if (key === "all") return { key, grain: "day" };

  if (key === "custom") {
    const fromMs = parseLocalDate(input.from);
    const toMs = parseLocalDate(input.to);
    const todayStart = localDayStart(nowMs, tz);
    const endLocal = toMs == null ? todayStart + DAY_MS : toMs + DAY_MS;
    const startLocal = fromMs == null ? endLocal - 7 * DAY_MS : fromMs;
    const grain: UsageGrain = endLocal - startLocal <= DAY_MS ? "hour" : "day";
    return {
      key,
      fromIso: localToIso(startLocal, tz),
      toIso: localToIso(endLocal, tz),
      grain,
    };
  }

  const days = key === "today" ? 1 : PRESET_DAYS[key];
  const endLocal = localDayStart(nowMs, tz) + DAY_MS;
  const startLocal = endLocal - days * DAY_MS;
  return {
    key,
    fromIso: localToIso(startLocal, tz),
    toIso: localToIso(endLocal, tz),
    grain: key === "today" ? "hour" : "day",
  };
}

function normalizeRangeKey(
  key: string | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined,
): UsageRangeKey {
  if (
    key === "today" ||
    key === "7d" ||
    key === "30d" ||
    key === "90d" ||
    key === "all" ||
    key === "custom"
  ) {
    return key;
  }
  if (from || to) return "custom";
  return DEFAULT_RANGE_KEY;
}

/** Local midnight of the day containing `ms`, expressed as a local-shifted ms. */
function localDayStart(ms: number, tz: number): number {
  return Math.floor((ms + tz * MINUTE_MS) / DAY_MS) * DAY_MS;
}

/** Local-shifted ms → real UTC ISO instant. */
function localToIso(localMs: number, tz: number): string {
  return new Date(localMs - tz * MINUTE_MS).toISOString();
}

/** "YYYY-MM-DD" interpreted as local midnight → local-shifted ms, or null. */
function parseLocalDate(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(wall) ? wall : null;
}

/** List every bucket in the window, so charts keep a continuous axis. */
export function enumerateBuckets(
  range: UsageRange,
  tzOffsetMinutes: number,
): string[] {
  if (!range.fromIso || !range.toIso) return [];
  const step = range.grain === "hour" ? HOUR_MS : DAY_MS;
  const tz = tzOffsetMinutes * MINUTE_MS;
  const start = Math.floor((Date.parse(range.fromIso) + tz) / step) * step;
  const end = Date.parse(range.toIso) + tz;
  const out: string[] = [];
  // Guard against an accidental huge range (e.g. a bad custom date).
  const max = 400;
  for (let t = start; t < end && out.length < max; t += step) {
    out.push(formatLocalBucket(t, range.grain));
  }
  return out;
}

/** Zero-fill a series so a gap day shows as an empty bar, not a missing one. */
export function fillSeries(
  points: readonly UsageSeriesPoint[],
  range: UsageRange,
  tzOffsetMinutes: number,
): UsageSeriesPoint[] {
  const byBucket = new Map(points.map((p) => [p.bucket, p]));
  const out: UsageSeriesPoint[] = [];
  for (const bucket of enumerateBuckets(range, tzOffsetMinutes)) {
    out.push(
      byBucket.get(bucket) ?? {
        bucket,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        images: 0,
      },
    );
  }
  return out.length > 0 ? out : [...points];
}

/** "MM-DD" for days, "HH:00" for hours. */
export function bucketLabel(bucket: string, grain: UsageGrain): string {
  return grain === "hour" ? `${bucket.slice(11, 13)}:00` : bucket.slice(5);
}

/** Clamp a `tzOffset` query value to a sane UTC offset in minutes. */
export function parseTzOffset(
  value: string | null | undefined,
  fallback = 480,
): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-720, Math.min(840, Math.trunc(n)));
}

/** JSON-safe range descriptor for the usage APIs. */
export function rangeToJson(range: UsageRange): {
  key: UsageRangeKey;
  from: string | null;
  to: string | null;
  grain: UsageGrain;
} {
  return {
    key: range.key,
    from: range.fromIso ?? null,
    to: range.toIso ?? null,
    grain: range.grain,
  };
}
