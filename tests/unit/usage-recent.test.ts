/**
 * `listRecentUsage` backs the admin overview's recent-requests table, which is
 * the only place where the billing mode (measured vs estimated) is visible.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { listRecentUsage, recordUsage } from "@/lib/db/usage";

function row(over: Partial<Parameters<typeof recordUsage>[0]> = {}) {
  return {
    apiKeyId: "k1",
    userId: "u1",
    providerId: "p1",
    model: "model-x",
    upstreamModel: "upstream-x",
    promptTokens: 10,
    completionTokens: 20,
    creditsUsed: 5,
    status: "success" as const,
    ...over,
  };
}

describe("listRecentUsage", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("returns nothing when there are no keys", async () => {
    expect(await listRecentUsage([])).toEqual([]);
  });

  it("merges keys and orders newest first", async () => {
    await recordUsage(row({ apiKeyId: "k1", model: "old" }));
    // Distinct millisecond timestamps, otherwise the sort has to break ties.
    await new Promise((r) => setTimeout(r, 3));
    await recordUsage(row({ apiKeyId: "k2", model: "newer" }));
    await new Promise((r) => setTimeout(r, 3));
    await recordUsage(row({ apiKeyId: "k1", model: "newest" }));

    const recent = await listRecentUsage(["k1", "k2"], { limit: 10 });
    expect(recent).toHaveLength(3);
    expect(recent[0].model).toBe("newest");
    expect(recent[1].model).toBe("newer");
    expect(recent[2].model).toBe("old");
  });

  it("honours the limit", async () => {
    for (let i = 0; i < 6; i++) {
      await recordUsage(row({ model: `m${i}` }));
    }
    expect(await listRecentUsage(["k1"], { limit: 4 })).toHaveLength(4);
  });

  it("preserves the billing mode, defaulting old rows to measured", async () => {
    await recordUsage(row({ model: "measured", billingMode: "usage" }));
    await recordUsage(row({ model: "estimated", billingMode: "estimated" }));
    // A row written before the field existed parses as "usage".
    await recordUsage(row({ model: "legacy" }));

    const recent = await listRecentUsage(["k1"], { limit: 10 });
    const byModel = new Map(recent.map((r) => [r.model, r]));
    expect(byModel.get("measured")?.billingMode).toBe("usage");
    expect(byModel.get("estimated")?.billingMode).toBe("estimated");
    expect(byModel.get("legacy")?.billingMode).toBe("usage");
  });

  it("keeps failed rows so they show up in the table", async () => {
    await recordUsage(
      row({ status: "error", promptTokens: 0, completionTokens: 0, creditsUsed: 0 }),
    );
    const recent = await listRecentUsage(["k1"], { limit: 5 });
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe("error");
  });
});
