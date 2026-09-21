/**
 * tests/unit/quota-calculator.test.ts
 */
import { describe, it, expect } from "vitest";
import {
  shouldRejectBeforeRequest,
  isOverQuotaAfterRequest,
  quotaDeltaFromUsage,
  aggregateByDay,
  estimateCredits,
} from "@/lib/quota/calculator";
import type { ApiKey, UsageLog } from "@/lib/db/types";

function makeKey(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k",
    userId: "u",
    label: "l",
    keyHash: "h".repeat(64),
    keyPrefix: "sk-relay-xxx",
    quotaType: "credits",
    quotaLimit: 100,
    quotaUsed: 0,
    expiresAt: null,
    enabled: true,
    allowedModels: [],
    createdAt: "2026-09-21T00:00:00.000Z",
    lastUsedAt: null,
    ...over,
  };
}

describe("shouldRejectBeforeRequest", () => {
  it("returns false when quotaUsed < quotaLimit", () => {
    const r = shouldRejectBeforeRequest(makeKey({ quotaUsed: 50, quotaLimit: 100 }));
    expect(r).toBe(false);
  });

  it("returns quota_exceeded_credits when used >= limit (credits)", () => {
    const r = shouldRejectBeforeRequest(makeKey({
      quotaType: "credits",
      quotaLimit: 100,
      quotaUsed: 100,
    }));
    expect(r).toEqual({ reason: "quota_exceeded_credits" });
  });

  it("returns quota_exceeded_tokens when used >= limit (tokens)", () => {
    const r = shouldRejectBeforeRequest(makeKey({
      quotaType: "tokens",
      quotaLimit: 1000,
      quotaUsed: 1000,
    }));
    expect(r).toEqual({ reason: "quota_exceeded_tokens" });
  });
});

describe("isOverQuotaAfterRequest", () => {
  it("detects crossing the limit", () => {
    expect(isOverQuotaAfterRequest({ key: makeKey({ quotaLimit: 100 }), newQuotaUsed: 101 })).toBe(true);
  });
  it("is false at exactly the limit", () => {
    expect(isOverQuotaAfterRequest({ key: makeKey({ quotaLimit: 100 }), newQuotaUsed: 100 })).toBe(false);
  });
});

describe("quotaDeltaFromUsage", () => {
  it("returns totalTokens when quotaType=tokens", () => {
    const d = quotaDeltaFromUsage({
      quotaType: "tokens",
      usage: { promptTokens: 100, completionTokens: 50 },
      model: "gpt-4o-mini",
    });
    expect(d).toBe(150);
  });
  it("returns the exact 积分 amount when quotaType=credits", () => {
    const d = quotaDeltaFromUsage({
      quotaType: "credits",
      usage: { promptTokens: 1000, completionTokens: 0 },
      model: "gpt-4o-mini",
    });
    // 1000 * 15 / 1000 = 15 units = 0.015 积分 — not rounded up to 1 积分
    expect(d).toBe(15);
  });

  it("does not round a sub-积分 request up to a whole 积分", () => {
    const d = quotaDeltaFromUsage({
      quotaType: "credits",
      usage: { promptTokens: 11, completionTokens: 7 },
      model: "gpt-4o-mini",
    });
    // 0.585 units → 1 unit; a whole-积分 ledger would have charged 1000 units
    expect(d).toBe(1);
    expect(d).toBeLessThan(1000);
  });
});

describe("aggregateByDay", () => {
  function log(p: number, c: number, day: string, credits: number): UsageLog {
    return {
      id: day + p,
      apiKeyId: "k",
      userId: "u",
      providerId: "p",
      model: "gpt-4o-mini",
      upstreamModel: "gpt-4o-mini",
      promptTokens: p,
      completionTokens: c,
      totalTokens: p + c,
      creditsUsed: credits,
      errorMessage: null,
      status: "success",
      createdAt: `${day}T10:00:00.000Z`,
    };
  }

  it("groups by day and sums", () => {
    const result = aggregateByDay([
      log(10, 5, "2026-09-21", 1),
      log(20, 10, "2026-09-21", 2),
      log(100, 50, "2026-09-22", 5),
    ]);
    expect(result).toEqual([
      { day: "2026-09-21", promptTokens: 30, completionTokens: 15, creditsUsed: 3, requests: 2 },
      { day: "2026-09-22", promptTokens: 100, completionTokens: 50, creditsUsed: 5, requests: 1 },
    ]);
  });

  it("excludes error logs", () => {
    const err: UsageLog = {
      ...log(100, 50, "2026-09-21", 99),
      status: "error",
    };
    const result = aggregateByDay([err]);
    expect(result).toEqual([]);
  });

  it("respects timezone offset", () => {
    // 2026-09-21T01:00:00Z + 480 minutes (UTC+8) = 2026-09-21T09:00 → still Sep 21
    const result = aggregateByDay([log(1, 1, "2026-09-21", 1)], 480);
    expect(result[0].day).toBe("2026-09-21");

    // 2026-09-21T20:00:00Z + 480 minutes = 2026-09-22T04:00 → Sep 22
    const late: UsageLog = {
      ...log(1, 1, "2026-09-21", 1),
      createdAt: "2026-09-21T20:00:00.000Z",
    };
    const r2 = aggregateByDay([late], 480);
    expect(r2[0].day).toBe("2026-09-22");
  });
});

describe("estimateCredits", () => {
  it("estimates based on character count", () => {
    const c = estimateCredits({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "a".repeat(400) }],
    });
    // 400 chars / 4 chars/token = 100 tokens → 100 * 15 / 1000 = 1.5 units → 2
    expect(c).toBe(2);
  });

  it("returns 0 for empty messages", () => {
    const c = estimateCredits({
      model: "gpt-4o-mini",
      messages: [],
    });
    expect(c).toBe(0);
  });
});
