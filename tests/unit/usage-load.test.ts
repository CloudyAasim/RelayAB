/**
 * tests/unit/usage-load.test.ts
 *
 * `loadUsageReport` stitches the retained per-key logs to the pure aggregator,
 * and `listUsageWithin` bounds how far back it reads.
 *
 * Key properties:
 *  - `range=all` reports lifetime totals from the running counters, so it stays
 *    correct even after the per-key log window has been trimmed.
 *  - a ranged read is bounded by the window in SQL, instead of always
 *    hydrating all 1000 rows.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest, getDb, getOne, run } from "@/lib/db/sqlite";
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
    __resetDbForTest();
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
    run("DELETE FROM usage_logs WHERE api_key_id = ?", ["k1"]);

    const report = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: 480,
      range: ALL,
    });

    expect(report.summary.requests).toBe(2);
    expect(report.summary.creditsUsed).toBe(10);
    expect(report.byKey).toEqual([]); // no retained logs to break down
  });

  it("restricts the report to one model when asked", async () => {
    await recordUsage(usage({ apiKeyId: "k1", model: "a", creditsUsed: 3 }));
    await recordUsage(usage({ apiKeyId: "k1", model: "b", creditsUsed: 5 }));

    const report = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: 480,
      range: ALL,
      model: "a",
    });

    expect(report.summary.requests).toBe(1);
    expect(report.summary.creditsUsed).toBe(3);
    expect(report.byModel.map((row) => row.id)).toEqual(["a"]);
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
    __resetDbForTest();
  });

  /** Seed `count` logs, one minute apart, newest at `baseMs`. */
  async function seed(apiKeyId: string, count: number, baseMs: number) {
    const stmt = getDb().prepare(
      `INSERT INTO usage_logs
         (id, api_key_id, user_id, provider_id, model, upstream_model,
          prompt_tokens, completion_tokens, total_tokens, credits_used,
          images, capability, status, error_message, billing_mode, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = count - 1; i >= 0; i--) {
      stmt.run(
        `l${i}`,
        apiKeyId,
        "u1",
        "p1",
        "m",
        "m",
        1,
        1,
        2,
        1,
        0,
        null,
        "success",
        null,
        "usage",
        new Date(baseMs - i * 60_000).toISOString(),
      );
    }
  }

  it("returns only the rows inside the window, without reading the whole history", async () => {
    const baseMs = Date.UTC(2026, 8, 27, 12, 0, 0);
    await seed("k1", 600, baseMs);

    // Log #249 (0-based) is the oldest row still inside the window.
    const fromIso = new Date(baseMs - 249 * 60_000).toISOString();

    const logs = await listUsageWithin("k1", { fromIso });

    // The bound is applied by the query, not by walking pages and stopping:
    // an unbounded read would have returned all 600 rows.
    expect(getOne<{ n: number }>("SELECT COUNT(*) AS n FROM usage_logs")).toEqual({ n: 600 });
    expect(logs.length).toBe(250);
    // Newest first, and the boundary row is included (`>= fromIso`).
    expect(logs[0].createdAt).toBe(new Date(baseMs).toISOString());
    expect(logs[249].createdAt).toBe(fromIso);
  });
});
