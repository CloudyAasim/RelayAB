/**
 * tests/unit/usage-web-search-subset.test.ts
 *
 * `report.webSearch` is a **filtered view** of the same rows the report already
 * counts. Two properties matter and both are asserted here:
 *
 *  - it recognizes every shape a search row has taken (environment backend,
 *    database provider, rows from before `capability` existed), and
 *  - it never changes the totals. A subset card that quietly adds itself to the
 *    summary would double-count every search in the product.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest, run } from "@/lib/db/sqlite";
import { recordUsage } from "@/lib/db/usage";
import { resolveRange } from "@/lib/usage/report";
import { loadUsageReport } from "@/lib/usage/load";
import { isWebSearchUsage, WEB_SEARCH_CAPABILITY, WEB_SEARCH_MODEL } from "@/lib/search/usage";

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

function searchRow(over: Partial<Parameters<typeof recordUsage>[0]> = {}) {
  return usage({
    providerId: "searxng",
    model: WEB_SEARCH_MODEL,
    upstreamModel: WEB_SEARCH_MODEL,
    capability: WEB_SEARCH_CAPABILITY,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed: 1,
    ...over,
  });
}

const RANGE = resolveRange({ key: "7d", tzOffsetMinutes: 480 });

beforeEach(() => {
  __resetDbForTest();
});

describe("isWebSearchUsage", () => {
  it("recognizes the capability even when the model is not the pseudo-model", () => {
    expect(isWebSearchUsage({ providerId: "x", model: "custom", capability: WEB_SEARCH_CAPABILITY })).toBe(
      true,
    );
  });

  it("recognizes an old log row with no capability, and a bucket row", () => {
    expect(isWebSearchUsage({ providerId: "searxng", model: WEB_SEARCH_MODEL })).toBe(true);
    expect(isWebSearchUsage({ providerId: "row-id", model: WEB_SEARCH_MODEL, capability: null })).toBe(
      true,
    );
  });

  it("matches the pseudo-model exactly, not as a prefix", () => {
    for (const model of ["web-search-pro", "websearch", "web-search-preview"]) {
      expect(isWebSearchUsage({ providerId: "p", model, capability: "chat" })).toBe(false);
    }
  });

  it("does not treat an ordinary chat request as search", () => {
    expect(isWebSearchUsage({ providerId: "p", model: "MiniMax-M3", capability: "chat" })).toBe(false);
  });
});

describe("loadUsageReport.webSearch", () => {
  it("counts search rows of every vintage and leaves the totals untouched", async () => {
    await recordUsage(usage({ model: "chat-model", creditsUsed: 10 }));
    await recordUsage(searchRow({ providerId: "searxng" })); // environment backend
    await recordUsage(searchRow({ providerId: "provider-row-id" })); // database provider
    // A row written before `/v1/search` recorded a capability.
    await recordUsage(
      usage({
        providerId: "searxng",
        model: WEB_SEARCH_MODEL,
        upstreamModel: WEB_SEARCH_MODEL,
        creditsUsed: 1,
      }),
    );

    const report = await loadUsageReport({ keyIds: ["k1"], tzOffsetMinutes: 480, range: RANGE });

    // Totals: everything, unchanged by the subset.
    expect(report.summary.requests).toBe(4);
    expect(report.summary.creditsUsed).toBe(13);

    // Subset: the three searches, never added to anything above.
    expect(report.webSearch.summary.requests).toBe(3);
    expect(report.webSearch.summary.creditsUsed).toBe(3);
    expect(report.webSearch.byProvider.map((row) => row.id).sort()).toEqual([
      "provider-row-id",
      "searxng",
    ]);
    expect(report.webSearch.series.reduce((n, p) => n + p.requests, 0)).toBe(3);
    // Same axis as the main series, so the two can be drawn together.
    expect(report.webSearch.series).toHaveLength(report.series.length);
  });

  it("reports an empty subset without disturbing anything else", async () => {
    await recordUsage(usage({ creditsUsed: 10 }));
    const report = await loadUsageReport({ keyIds: ["k1"], tzOffsetMinutes: 480, range: RANGE });
    expect(report.summary.creditsUsed).toBe(10);
    expect(report.webSearch.summary).toMatchObject({ requests: 0, creditsUsed: 0 });
    expect(report.webSearch.byProvider).toEqual([]);
  });

  it("answers the same from the row fallback when no buckets exist", async () => {
    await recordUsage(usage({ model: "chat-model", creditsUsed: 10 }));
    await recordUsage(searchRow({ creditsUsed: 2 }));
    run("DELETE FROM usage_buckets");

    const report = await loadUsageReport({ keyIds: ["k1"], tzOffsetMinutes: 480, range: RANGE });
    expect(report.summary.requests).toBe(2);
    expect(report.webSearch.summary).toMatchObject({ requests: 1, creditsUsed: 2 });
    expect(report.webSearch.byProvider).toEqual([
      expect.objectContaining({ id: "searxng", requests: 1 }),
    ]);
  });

  it("honours the model scope, including when the scope is not search", async () => {
    await recordUsage(usage({ model: "chat-model", creditsUsed: 10 }));
    await recordUsage(searchRow({ creditsUsed: 2 }));

    const chatOnly = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: 480,
      range: RANGE,
      model: "chat-model",
    });
    expect(chatOnly.summary.requests).toBe(1);
    expect(chatOnly.webSearch.summary.requests).toBe(0);

    const searchOnly = await loadUsageReport({
      keyIds: ["k1"],
      tzOffsetMinutes: 480,
      range: RANGE,
      model: WEB_SEARCH_MODEL,
    });
    expect(searchOnly.summary.requests).toBe(1);
    expect(searchOnly.webSearch.summary.requests).toBe(1);
  });

  it("does not count an error row, because totals never did", async () => {
    await recordUsage(searchRow({ status: "error", creditsUsed: 0 }));
    const report = await loadUsageReport({ keyIds: ["k1"], tzOffsetMinutes: 480, range: RANGE });
    // Error rows are absent from both the totals and every view built on them.
    expect(report.summary.requests).toBe(0);
    expect(report.webSearch.summary.requests).toBe(0);
  });
});
