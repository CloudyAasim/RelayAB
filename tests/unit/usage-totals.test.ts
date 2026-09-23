/**
 * tests/unit/usage-totals.test.ts
 *
 * The dashboard and admin overview used to compute "tokens used" by reading
 * every usage-log hash for every key (up to `MAX_LOGS_PER_KEY` = 1000 reads per
 * key). That dominated page load. `recordUsage` now maintains a running
 * per-key counter in the same MULTI transaction, and the all-time aggregates
 * read that instead. Date-ranged queries still scan the logs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest, getRedis, k } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  MAX_LOGS_PER_KEY,
  aggregateByKey,
  aggregateByKeyMany,
  aggregateByUser,
  listUsageByKey,
  recordUsage,
} from "@/lib/db/usage";

function usage(over: Partial<Parameters<typeof recordUsage>[0]> = {}) {
  return {
    apiKeyId: "k1",
    userId: "u1",
    providerId: "p1",
    model: "MiniMax-M3",
    upstreamModel: "MiniMax-M3",
    promptTokens: 10,
    completionTokens: 20,
    creditsUsed: 5,
    status: "success" as const,
    ...over,
  };
}

describe("usage running totals", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("keeps the per-key counter in sync with recorded usage", async () => {
    await recordUsage(usage());
    await recordUsage(usage({ promptTokens: 1, completionTokens: 2, creditsUsed: 3 }));

    expect(await aggregateByKey("k1")).toEqual({
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      creditsUsed: 8,
      requestCount: 2,
    });
  });

  it("does not count failed requests", async () => {
    await recordUsage(usage());
    await recordUsage(
      usage({ status: "error", promptTokens: 0, completionTokens: 0, creditsUsed: 0 }),
    );

    const agg = await aggregateByKey("k1");
    expect(agg.requestCount).toBe(1);
    expect(agg.totalTokens).toBe(30);
  });

  it("answers all-time totals without touching the log list", async () => {
    await recordUsage(usage());
    // Remove the log list: only the running counter can answer from here.
    await getRedis().del(k.usageLogsByKey("k1"));
    expect(await listUsageByKey("k1")).toHaveLength(0);

    expect((await aggregateByKey("k1")).totalTokens).toBe(30);
  });

  it("falls back to scanning when a date range is requested", async () => {
    await recordUsage(usage());
    const future = "2999-01-01T00:00:00.000Z";
    expect((await aggregateByKey("k1", { from: future })).totalTokens).toBe(0);
  });

  it("sums per-key counters across a user's keys", async () => {
    await recordUsage(usage({ apiKeyId: "k1" }));
    await recordUsage(usage({ apiKeyId: "k2", promptTokens: 5, completionTokens: 5 }));

    const agg = await aggregateByUser(["k1", "k2"]);
    expect(agg.totalTokens).toBe(40);
    expect(agg.requestCount).toBe(2);
  });

  it("backfills the counter from pre-existing logs on first read", async () => {
    // Simulate a key whose usage was recorded before counters existed.
    const redis = getRedis();
    const logId = "01LEGACYLOG";
    await redis.hset(k.usageLog("k1", logId), {
      id: logId,
      apiKeyId: "k1",
      userId: "u1",
      providerId: "p1",
      model: "MiniMax-M3",
      upstreamModel: "MiniMax-M3",
      promptTokens: "7",
      completionTokens: "8",
      totalTokens: "15",
      creditsUsed: "2",
      status: "success",
      errorMessage: "",
      createdAt: new Date().toISOString(),
    });
    await redis.lpush(k.usageLogsByKey("k1"), logId);

    // First read has no counter, so it scans and backfills.
    expect((await aggregateByKey("k1")).totalTokens).toBe(15);

    // Counter is now authoritative: removing the logs must not change it.
    await redis.del(k.usageLogsByKey("k1"));
    expect((await aggregateByKey("k1")).totalTokens).toBe(15);
  });

  it("L1: aggregateByKeyMany stays accurate beyond MAX_LOGS_PER_KEY", async () => {
    // Record 3x the cap. The log list caps at 1000, but the running counter
    // holds the full amount — and aggregateByKeyMany is what
    // /api/admin/usage calls for its totals.
    const total = MAX_LOGS_PER_KEY * 3;
    for (let i = 0; i < total; i++) {
      await recordUsage(usage());
    }
    // Counter must agree with the actual write count, regardless of log cap.
    const totals = await aggregateByKeyMany(["k1"]);
    expect(totals).toHaveLength(1);
    expect(totals[0].requestCount).toBe(total);
    expect(totals[0].totalTokens).toBe(30 * total);
    expect(totals[0].creditsUsed).toBe(5 * total);
    // Sanity: log list capped at the per-key max.
    expect(await listUsageByKey("k1", { limit: MAX_LOGS_PER_KEY })).toHaveLength(MAX_LOGS_PER_KEY);
  });
});
