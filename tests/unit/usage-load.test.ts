/**
 * tests/unit/usage-load.test.ts
 *
 * `loadUsageReport` stitches the retained per-key logs to the pure aggregator,
 * and `listUsageWithin` bounds how far back it reads.
 *
 * Key properties:
 *  - `range=all` reports lifetime totals from the running counters, so it stays
 *    correct even after the per-key log window has been trimmed.
 *  - a ranged read stops once the list (newest-first) crosses the lower bound,
 *    instead of always hydrating all 1000 rows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest, getRedis, k } from "@/lib/db/redis";
import { createMemoryRedis, type RedisLike } from "@/lib/db/__mocks__/memory-redis";
import { listUsageWithin, recordUsage } from "@/lib/db/usage";
import { resolveRange } from "@/lib/usage/report";
import { loadUsageReport } from "@/lib/usage/load";

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

const ALL = resolveRange({ key: "all", tzOffsetMinutes: 480 });

describe("loadUsageReport", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("summarizes successful requests and groups by key and model", async () => {
    await recordUsage(usage({ apiKeyId: "k1", model: "m1", creditsUsed: 5 }));
    await recordUsage(usage({ apiKeyId: "k2", model: "m2", creditsUsed: 7 }));
    await recordUsage(usage({ apiKeyId: "k2", model: "m2", creditsUsed: 1, status: "error" }));

    const report = await loadUsageReport({
      keyIds: ["k1", "k2"],
      tzOffsetMinutes: 480,
      range: ALL,
    });

    expect(report.summary.requests).toBe(2);
    expect(report.summary.creditsUsed).toBe(12);
    expect(report.summary.totalTokens).toBe(60);

    expect(report.byKey.map((row) => row.id)).toEqual(["k2", "k1"]);
    expect(report.byKey[0]).toMatchObject({ id: "k2", requests: 1, creditsUsed: 7 });
    expect(report.byModel).toHaveLength(2);
  });

  it("reports lifetime totals from counters even after logs are gone", async () => {
    await recordUsage(usage({ apiKeyId: "k1", creditsUsed: 4 }));
    await recordUsage(usage({ apiKeyId: "k1", creditsUsed: 6 }));

    // Simulate the per-key log window being trimmed while the counter survives.
    await getRedis().del(k.usageLogsByKey("k1"));

    const report = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: 480,
      range: ALL,
    });

    expect(report.summary.requests).toBe(2);
    expect(report.summary.creditsUsed).toBe(10);
    expect(report.byKey).toEqual([]); // no retained logs to break down
  });

  it("includes the per-user breakdown only when asked", async () => {
    await recordUsage(usage({ apiKeyId: "k1", userId: "u1" }));
    await recordUsage(usage({ apiKeyId: "k2", userId: "u2" }));

    const base = await loadUsageReport({
      keyIds: ["k1", "k2"],
      tzOffsetMinutes: 480,
      range: ALL,
    });
    expect(base.byUser).toEqual([]);

    const withUsers = await loadUsageReport({
      keyIds: ["k1", "k2"],
      tzOffsetMinutes: 480,
      range: ALL,
      includeUsers: true,
    });
    expect(withUsers.byUser.map((row) => row.id).sort()).toEqual(["u1", "u2"]);
  });
});

describe("listUsageWithin (bounded read)", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  /** Seed `count` newest-first logs, one minute apart, into the active client. */
  async function seed(apiKeyId: string, count: number, baseMs: number) {
    const redis = getRedis();
    for (let i = count - 1; i >= 0; i--) {
      const id = `l${i}`;
      const createdAt = new Date(baseMs - i * 60_000).toISOString();
      await redis.hset(k.usageLog(apiKeyId, id), {
        id,
        apiKeyId,
        userId: "u1",
        providerId: "p1",
        model: "m",
        upstreamModel: "m",
        promptTokens: "1",
        completionTokens: "1",
        totalTokens: "2",
        creditsUsed: "1",
        status: "success",
        errorMessage: "",
        billingMode: "usage",
        createdAt,
      });
      await redis.lpush(k.usageLogsByKey(apiKeyId), id);
    }
  }

  it("stops walking once the page crosses the lower bound", async () => {
    const baseMs = Date.UTC(2026, 8, 27, 12, 0, 0);

    // A counting client so we can observe how many list reads happen.
    const redis = createMemoryRedis();
    let lrangeCalls = 0;
    const original = redis.lrange.bind(redis);
    (redis as unknown as { lrange: RedisLike["lrange"] }).lrange = ((...args: Parameters<
      RedisLike["lrange"]
    >) => {
      lrangeCalls += 1;
      return original(...args);
    }) as RedisLike["lrange"];
    __setRedisForTest(redis);

    await seed("k1", 600, baseMs);
    // Log #250 (0-based) is the oldest row still inside the window.
    const fromIso = new Date(baseMs - 249 * 60_000).toISOString();

    const logs = await listUsageWithin("k1", { fromIso });

    // Two pages (0–199, 200–399) is enough: the second page's oldest row is
    // already older than the window, so page three is never requested.
    expect(lrangeCalls).toBe(2);
    expect(logs.length).toBe(400);
    expect(logs[0].createdAt).toBe(new Date(baseMs).toISOString());
  });
});
