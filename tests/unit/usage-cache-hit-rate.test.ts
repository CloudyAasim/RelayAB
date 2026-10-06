/**
 * tests/unit/usage-cache-hit-rate.test.ts
 *
 * A cache hit rate that reads 0% when the truth is "nobody has looked" is a
 * claim about a vendor's behaviour, made out of an empty column.
 *
 * Cache tokens are optional on a usage row on purpose. A vendor that does not
 * report a cache writes no figure, and "no prompt was ever served from cache"
 * and "this vendor does not report a cache" are different facts — the first is a
 * measurement, the second is an absence of one. This file keeps them apart.
 *
 * The reporting count is what separates them, so the aggregation has to carry it
 * and the render has to branch on it. Neither is optional: a rate computed over
 * all requests, or a zero painted where nothing was reported, both look right
 * on the page and are both wrong.
 */
import { describe, it, expect } from "vitest";

import {
  EMPTY_USAGE_SUMMARY,
  addSummary,
  cacheHitRate,
  sumSummaries,
  type UsageSummary,
} from "@/lib/usage/report";
import type { UsageLog } from "@/lib/db/types";

function log(over: Partial<UsageLog>): UsageLog {
  return {
    id: "l",
    userId: "u",
    apiKeyId: "k",
    providerId: "p",
    model: "m",
    status: "success",
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    creditsUsed: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  } as UsageLog;
}

const collect = (logs: UsageLog[]): UsageSummary => {
  const acc = { ...EMPTY_USAGE_SUMMARY };
  for (const l of logs) addSummary(acc, l);
  return acc;
};

describe("the aggregation knows who reported a cache", () => {
  it("counts a row only when it carried a figure", () => {
    const s = collect([
      log({ promptTokens: 100, cachedPromptTokens: 40 }),
      log({ promptTokens: 100, cachedPromptTokens: 0 }),
      log({ promptTokens: 100 }), // vendor reported nothing
    ]);
    expect(s.cachedPromptTokens).toBe(40);
    expect(s.cacheReportedRequests).toBe(2);
    expect(s.requests).toBe(3);
  });

  it("a row reporting zero is not the same as a row reporting nothing", () => {
    // Both produce the same cached total. Only the count separates them.
    const zero = collect([log({ promptTokens: 100, cachedPromptTokens: 0 })]);
    const silent = collect([log({ promptTokens: 100 })]);
    expect(zero.cachedPromptTokens).toBe(silent.cachedPromptTokens);
    expect(zero.cacheReportedRequests).toBe(1);
    expect(silent.cacheReportedRequests).toBe(0);
  });

  it("and failed requests do not vote either way", () => {
    const s = collect([
      log({ status: "error", promptTokens: 10, cachedPromptTokens: 5 }),
      log({ promptTokens: 100, cachedPromptTokens: 25 }),
    ]);
    expect(s.requests).toBe(1);
    expect(s.cacheReportedRequests).toBe(1);
  });

  it("summing summaries keeps both halves", () => {
    const total = sumSummaries([
      { ...EMPTY_USAGE_SUMMARY, cachedPromptTokens: 10, cacheReportedRequests: 1 },
      { ...EMPTY_USAGE_SUMMARY, cachedPromptTokens: 5, cacheReportedRequests: 2 },
    ]);
    expect(total.cachedPromptTokens).toBe(15);
    expect(total.cacheReportedRequests).toBe(3);
  });
});

describe("the rate", () => {
  it("is cached over prompt, which is the set the cache is served from", () => {
    // The same subset billing charges the remainder of, so the fraction means
    // the same thing here as it does on an invoice.
    expect(cacheHitRate(collect([log({ promptTokens: 1000, cachedPromptTokens: 250 })]))).toBe(0.25);
  });

  it("denominator covers only the rows that reported", () => {
    // One row says 100 of 100 was cached; the next says nothing. Counting the
    // silent row's prompt tokens in the denominator while leaving it out of the
    // numerator reports 50% for a vendor that served 100% of what it reported —
    // and both numbers are individually right, which is what makes it plausible.
    const s = collect([
      log({ promptTokens: 100, cachedPromptTokens: 100 }),
      log({ promptTokens: 100 }),
    ]);
    expect(cacheHitRate(s)).toBe(1);
    expect(s.promptTokens).toBe(200);
    expect(s.cacheReportedPromptTokens).toBe(100);
  });

  it("is unknown, not zero, when nothing reported a cache", () => {
    // The whole point. A 0% here says the vendor never caches.
    expect(cacheHitRate(collect([log({ promptTokens: 100 })]))).toBeNull();
    expect(cacheHitRate(EMPTY_USAGE_SUMMARY)).toBeNull();
  });

  it("is zero when reporting said so", () => {
    expect(cacheHitRate(collect([log({ promptTokens: 100, cachedPromptTokens: 0 })]))).toBe(0);
  });

  it("ignores silence in a period where somebody else spoke", () => {
    // Mixed period: the rate describes the requests that reported, and the count
    // in the hint says how many that was. Averaging the silent ones in as zero
    // would understate every vendor that reports intermittently.
    const s = collect([
      log({ promptTokens: 100, cachedPromptTokens: 100 }),
      log({ promptTokens: 100 }),
    ]);
    expect(cacheHitRate(s)).toBe(1);
    expect(s.cacheReportedRequests).toBe(1);
  });

  it("is unknown rather than infinite when there were no prompt tokens", () => {
    expect(cacheHitRate(collect([log({ promptTokens: 0, cachedPromptTokens: 0 })]))).toBeNull();
  });

  it("never exceeds one, even if a vendor reports more than it sent", () => {
    // Defensive: a bad figure should not produce a 140% bar.
    expect(cacheHitRate(collect([log({ promptTokens: 100, cachedPromptTokens: 140 })]))).toBe(1);
  });
});

describe("the page", () => {
  const page = () =>
    require("node:fs").readFileSync(
      `${process.cwd()}/src/app/(user)/dashboard/usage/page.tsx`,
      "utf-8",
    ) as string;

  it("puts the rate in the same card as the trend", () => {
    const src = page();
    const card = src.slice(src.indexOf('title={t("usage.chart.title")}'));
    expect(card.slice(0, 3000)).toContain("cacheHitRate(report.summary)");
  });

  it("and has a word for unknown, so it never renders a bare 0%", () => {
    const src = page();
    expect(src).toContain("usage.stat.cacheUnreported");
    expect(src).toMatch(/rate === null \? t\("usage\.stat\.cacheUnreported"\)/);
  });
});