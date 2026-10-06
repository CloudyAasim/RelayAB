/**
 * tests/unit/usage-bucket-equivalence.test.ts
 *
 * Range figures are now read from `usage_buckets` instead of from `usage_logs`.
 * That is only safe if the two produce the same numbers, because the alternative is
 * a chart that quietly says something different from the one it replaced — and the
 * rows it replaced were the only record anyone could check against.
 *
 * So this file does not test the buckets in isolation. It records the same traffic
 * both ways and compares every figure the page shows: the totals, the series at
 * both grains, and all four breakdowns. A change that moves any of them fails here,
 * which is the point — a pre-aggregation that differs from its source by even one
 * row is a bug, not a rounding.
 *
 * The two halves are seeded differently, on purpose:
 *
 *  - The aggregation half writes `usage_logs` rows with a chosen `created_at` and
 *    then rebuilds. `recordUsage` stamps the real wall clock — usage is recorded
 *    when the request finished, not when a test decided to place it — so traffic
 *    spread across hours cannot be seeded through the write path at all: every
 *    row would land in the same hour as every other, and an hour-boundary test
 *    would pass without ever crossing a boundary.
 *  - The write-path half uses `recordUsage`, because that is the only thing that
 *    can test the increment that happens as traffic arrives, and reads the table
 *    directly so that no rebuild can quietly stand in for it.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest, getAll, run } from "@/lib/db/sqlite";
import {
  MAX_LOGS_PER_KEY,
  listUsageByKey,
  listUsageBuckets,
  prepareUsageBuckets,
  rebuildUsageBuckets,
  recordUsage,
  utcHourOf,
  __resetBucketPreparationForTest,
  type RecordUsageInput,
} from "@/lib/db/usage";
import { loadUsageReport } from "@/lib/usage/load";
import { group, resolveRange, series, summarize } from "@/lib/usage/report";
import { groupBuckets, seriesFromBuckets, summarizeBuckets } from "@/lib/usage/buckets";
import type { UsageLog } from "@/lib/db/types";

const TZ_UTC = 0;
const TZ = 480; // the app's default, and one of its two whole-hour zones

/** A window that contains every fixture row with room to spare. */
const FROM = "2026-10-05T16:00:00.000Z";
const TO = "2026-10-09T16:00:00.000Z";

interface Seed {
  at: string;
  key?: string;
  user?: string;
  provider?: string;
  model?: string;
  prompt?: number;
  completion?: number;
  credits?: number;
  images?: number;
  status?: "success" | "error";
  /** Omit for a request whose vendor reported no cache at all. */
  cached?: number;
}

let seq = 0;

/** A `usage_buckets` row as stored, read without the row-to-entity mapping. */
interface StoredBucket {
  api_key_id: string;
  model: string;
  bucket: string;
  requests: number;
  credits_used: number;
  total_tokens: number;
  cached_prompt_tokens: number;
  cache_reported_prompt_tokens: number;
  cache_reported_requests: number;
}

/** One `usage_logs` row at a chosen instant. */
function seed(row: Seed): void {
  const prompt = row.prompt ?? 10;
  const completion = row.completion ?? 4;
  run(
    `INSERT INTO usage_logs
       (id, api_key_id, user_id, provider_id, model, upstream_model,
        prompt_tokens, completion_tokens, total_tokens, credits_used,
        images, capability, status, error_message, billing_mode, created_at,
        cached_prompt_tokens, cache_write_tokens)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,'usage',?,?,NULL)`,
    [
      `seed-${seq++}`,
      row.key ?? "k1",
      row.user ?? "u1",
      row.provider ?? "prov",
      row.model ?? "m-a",
      row.model ?? "m-a",
      prompt,
      completion,
      prompt + completion,
      row.credits ?? 1,
      row.status ?? "success",
      row.at,
      row.cached ?? null,
    ],
  );
}

/** The rows read back through the schema — the "before" side of every comparison. */
async function rows(keyIds: readonly string[]): Promise<UsageLog[]> {
  const perKey = await Promise.all(
    keyIds.map((id) => listUsageByKey(id, { limit: MAX_LOGS_PER_KEY })),
  );
  return perKey
    .flat()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Traffic that crosses hours, local days, models, providers, keys and owners. */
const TRAFFIC: Seed[] = [
  // Two requests inside one UTC hour. They must also share a local hour, because
  // both display zones are whole hours.
  { at: "2026-10-06T04:12:00.000Z", prompt: 100, credits: 1 },
  { at: "2026-10-06T04:59:00.000Z", prompt: 100, credits: 2 },
  // One minute later is a different UTC hour, and so a different local one.
  { at: "2026-10-06T05:00:00.000Z", prompt: 200, credits: 3 },
  // 15:30Z is 23:30 on the 6th in UTC+8; 16:30Z is 00:30 on the 7th. Same UTC
  // date, different local date — the case where "which hour" and "which day" are
  // different questions, and where a local day is not a prefix of the UTC one.
  { at: "2026-10-06T15:30:00.000Z", prompt: 10, credits: 4 },
  { at: "2026-10-06T16:30:00.000Z", prompt: 10, credits: 5 },
  // A second day, a second model, a second provider, a second key and owner, and
  // the only row that produced media.
  { at: "2026-10-07T05:00:00.000Z", prompt: 300, credits: 6 },
  { at: "2026-10-07T06:00:00.000Z", model: "m-b", prompt: 50, credits: 7 },
  { at: "2026-10-07T07:00:00.000Z", provider: "prov2", prompt: 70, credits: 8 },
  { at: "2026-10-07T08:00:00.000Z", key: "k2", user: "u2", prompt: 90, credits: 9, images: 3 },
  // A failed request: neither path may count it.
  { at: "2026-10-07T08:30:00.000Z", status: "error", prompt: 999, credits: 999 },
  // The pair the cache rate's denominator is built from: one request that
  // reported a cache, and one that said nothing at all.
  { at: "2026-10-07T09:00:00.000Z", prompt: 400, cached: 400 },
  { at: "2026-10-07T09:30:00.000Z", prompt: 800 },
];

function seedTraffic(): void {
  __resetDbForTest();
  __resetBucketPreparationForTest();
  seq = 0;
  for (const row of TRAFFIC) seed(row);
  rebuildUsageBuckets();
  // Claim the one-shot backfill before the reads below, so what they compare is
  // the stored buckets rather than a fresh rebuild of the same rows. Without
  // this the file would be asserting that GROUP BY equals itself.
  prepareUsageBuckets();
}

describe("the buckets say what the rows say", () => {
  let logs: UsageLog[];
  let buckets: Awaited<ReturnType<typeof listUsageBuckets>>;

  beforeEach(async () => {
    seedTraffic();
    logs = await rows(["k1", "k2"]);
    buckets = await listUsageBuckets(["k1", "k2"], { fromIso: FROM, toIso: TO });
  });

  it("on the totals", () => {
    expect(summarizeBuckets(buckets)).toEqual(summarize(logs));
  });

  it("on the series, at day grain", () => {
    expect(seriesFromBuckets(buckets, "day", TZ)).toEqual(series(logs, "day", TZ, FROM, TO));
  });

  it("on the series, at hour grain — where the whole-hour offset is load-bearing", () => {
    expect(seriesFromBuckets(buckets, "hour", TZ)).toEqual(series(logs, "hour", TZ, FROM, TO));
  });

  it("on all four breakdowns", () => {
    for (const field of ["apiKeyId", "model", "providerId", "userId"] as const) {
      expect(groupBuckets(buckets, field)).toEqual(group(logs, field));
    }
  });

  it("on the cache denominator, which is the one that was wrong before", () => {
    const s = summarizeBuckets(buckets);
    expect(s.cachedPromptTokens).toBe(400);
    // Only the reporting request's prompt, not the silent one that followed it.
    expect(s.cacheReportedPromptTokens).toBe(400);
    expect(s.cacheReportedRequests).toBe(1);
  });

  it("in the other display zone, where a local day is not a prefix of the UTC one", () => {
    expect(seriesFromBuckets(buckets, "hour", TZ_UTC)).toEqual(
      series(logs, "hour", TZ_UTC, FROM, TO),
    );
    expect(seriesFromBuckets(buckets, "day", TZ_UTC)).toEqual(
      series(logs, "day", TZ_UTC, FROM, TO),
    );
  });
});

describe("the premise the bucketing rests on", () => {
  it("every range this app can build starts and ends on a whole UTC hour", () => {
    // A range beginning mid-hour would hand the bucket path a first bucket that
    // holds traffic from before the window, while the row path excluded it — the
    // two would stop agreeing, and only for the range that happened to cut an
    // hour in half. Every preset and every custom range starts at local midnight,
    // which in a whole-hour zone is a whole UTC hour. A "last 6 hours" preset
    // would break this, and this is the test that says so.
    for (const tz of [TZ_UTC, TZ]) {
      for (const key of ["today", "7d", "30d", "90d", "all", "custom"] as const) {
        const range = resolveRange({
          key,
          ...(key === "custom" ? { from: "2026-10-01", to: "2026-10-06" } : {}),
          tzOffsetMinutes: tz,
          now: new Date("2026-10-06T12:00:00.000Z"),
        });
        for (const bound of [range.fromIso, range.toIso]) {
          if (!bound) continue;
          expect(bound, `${key} at UTC+${tz / 60}`).toMatch(/T\d{2}:00:00\.000Z$/);
        }
      }
    }
  });
});

describe("the increment that happens as traffic arrives", () => {
  beforeEach(() => {
    __resetDbForTest();
    __resetBucketPreparationForTest();
  });

  const call = (over: Partial<RecordUsageInput> = {}) =>
    recordUsage({
      apiKeyId: "k1",
      userId: "u1",
      providerId: "prov",
      model: "m-a",
      upstreamModel: "m-a",
      promptTokens: 100,
      completionTokens: 4,
      creditsUsed: 2,
      status: "success",
      ...over,
    });

  /** Straight out of the table: a rebuild here would stand in for the increment. */
  const stored = (): StoredBucket[] =>
    getAll<StoredBucket>("SELECT * FROM usage_buckets ORDER BY bucket");

  it("accumulates into the hour the request finished in", async () => {
    await call({ promptTokens: 100, completionTokens: 4, creditsUsed: 2 });
    await call({ promptTokens: 50, completionTokens: 1, creditsUsed: 3 });
    await call({ model: "m-b", upstreamModel: "m-b", promptTokens: 10, completionTokens: 0, creditsUsed: 1 });

    const sameModel = stored().filter((b) => b.model === "m-a");
    expect(sameModel).toHaveLength(1);
    expect(sameModel[0].bucket).toBe(utcHourOf(new Date().toISOString()));
    // Both halves of the upsert, not just the insert. A column written on the
    // first row and never incremented reads as a real number for ever after.
    expect(sameModel[0].requests).toBe(2);
    expect(sameModel[0].credits_used).toBe(5);
    expect(sameModel[0].total_tokens).toBe(104 + 51);
  });

  it("keeps the cache denominator honest across requests", async () => {
    await call({ promptTokens: 400, completionTokens: 0, cachedPromptTokens: 400 });
    await call({ promptTokens: 800, completionTokens: 0 });
    const [bucket] = stored();
    expect(bucket.cached_prompt_tokens).toBe(400);
    // The silent request's 800 belong to neither side of the rate.
    expect(bucket.cache_reported_prompt_tokens).toBe(400);
    expect(bucket.cache_reported_requests).toBe(1);
  });

  it("does not count a failed request", async () => {
    await call();
    await call({ status: "error", promptTokens: 999, completionTokens: 0, creditsUsed: 999 });
    const [bucket] = stored();
    expect(bucket.requests).toBe(1);
    expect(bucket.credits_used).toBe(2);
  });

  it("agrees with a rebuild, so a restart cannot move the numbers", async () => {
    await call();
    await call({ promptTokens: 50, completionTokens: 1, creditsUsed: 3 });
    const before = stored();
    rebuildUsageBuckets();
    expect(stored()).toEqual(before);
  });
});

describe("what the buckets buy", () => {
  beforeEach(() => {
    __resetDbForTest();
    __resetBucketPreparationForTest();
    seq = 0;
  });

  const range = (from: string, to: string) =>
    resolveRange({ key: "custom", from, to, tzOffsetMinutes: TZ });

  it("a figure that survives the rows being gone", async () => {
    for (let i = 0; i < 40; i++) seed({ at: "2026-10-06T04:12:00.000Z", credits: 1 });
    seed({ at: "2026-10-07T04:12:00.000Z", credits: 5 });
    rebuildUsageBuckets();
    prepareUsageBuckets();

    // Everything from the first day, removed the way the cap removes it.
    run("DELETE FROM usage_logs WHERE created_at < ?", ["2026-10-07T00:00:00.000Z"]);

    const report = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: TZ,
      range: range("2026-10-06", "2026-10-07"),
    });

    expect(report.summary.requests).toBe(41);
    expect(report.summary.creditsUsed).toBe(45);
    expect(report.byModel).toEqual([expect.objectContaining({ id: "m-a", creditsUsed: 45 })]);
    // The point of the table: nothing was cut, so the warning does not appear.
    expect(report.truncatedKeys).toBe(0);
  });

  it("the same data reports truncation on the row path and not on the bucket path", async () => {
    for (let i = 0; i < MAX_LOGS_PER_KEY; i++) {
      seed({ at: "2026-10-06T04:12:00.000Z", credits: 1 });
    }
    rebuildUsageBuckets();
    prepareUsageBuckets();

    const input = { keyIds: ["k1"], tzOffsetMinutes: TZ, range: range("2026-10-06", "2026-10-06") };
    const viaBuckets = await loadUsageReport(input);

    run("DELETE FROM usage_buckets");
    const viaRows = await loadUsageReport(input);

    // Identical totals, and the flag says which one is bounded. That difference
    // is the whole reason the fast path exists: "your key is busy" and "you are
    // looking at last month" are the same condition, and only one of them was
    // ever counted.
    expect(viaBuckets.summary.requests).toBe(MAX_LOGS_PER_KEY);
    expect(viaRows.summary.requests).toBe(MAX_LOGS_PER_KEY);
    expect(viaBuckets.truncatedKeys).toBe(0);
    expect(viaRows.truncatedKeys).toBe(1);
  });

  it("still answers from the rows when the buckets are not there", async () => {
    seed({ at: "2026-10-06T04:12:00.000Z", credits: 3 });
    rebuildUsageBuckets();
    // A process that already prepared, whose buckets were then lost. Claiming
    // preparation first is what makes this the fallback rather than a rebuild.
    prepareUsageBuckets();
    run("DELETE FROM usage_buckets");
    expect(getAll("SELECT * FROM usage_buckets")).toHaveLength(0);

    const report = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: TZ,
      range: range("2026-10-06", "2026-10-06"),
    });

    expect(report.summary.requests).toBe(1);
    expect(report.summary.creditsUsed).toBe(3);
    expect(report.byModel).toEqual([expect.objectContaining({ id: "m-a", creditsUsed: 3 })]);
  });
});
