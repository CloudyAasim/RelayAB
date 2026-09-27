/**
 * tests/unit/usage-load.test.ts
 *
 * `loadUsageReport` stitches the retained per-key logs to the pure aggregator.
 * Key property: `range=all` reports lifetime totals from the running counters,
 * so it stays correct even after the per-key log window has been trimmed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest, getRedis, k } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { recordUsage } from "@/lib/db/usage";
import { resolveRange } from "@/lib/usage/report";
import { loadUsageReport } from "@/lib/usage/load";
import type { ApiKey } from "@/lib/db/types";

function apiKey(id: string, userId = "u1"): ApiKey {
  return {
    id,
    userId,
    label: id,
    keyHash: "h",
    keyPrefix: `sk-…${id}`,
    expiresAt: null,
    forceDisabled: false,
    enabled: true,
    allowedModels: [],
    createdAt: "2026-09-20T00:00:00.000Z",
    lastUsedAt: null,
  };
}

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
      keys: [apiKey("k1"), apiKey("k2")],
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
      keys: [apiKey("k1")],
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
      keys: [apiKey("k1", "u1"), apiKey("k2", "u2")],
      tzOffsetMinutes: 480,
      range: ALL,
    });
    expect(base.byUser).toEqual([]);

    const withUsers = await loadUsageReport({
      keys: [apiKey("k1", "u1"), apiKey("k2", "u2")],
      tzOffsetMinutes: 480,
      range: ALL,
      includeUsers: true,
    });
    expect(withUsers.byUser.map((row) => row.id).sort()).toEqual(["u1", "u2"]);
  });
});
