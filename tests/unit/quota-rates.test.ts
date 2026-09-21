/**
 * tests/unit/quota-rates.test.ts
 *
 * Model rates are expressed in 积分 per 1,000,000 tokens; `computeCredits`
 * returns integer 0.001-积分 units.
 */
import { describe, it, expect } from "vitest";
import {
  MODEL_RATES,
  DEFAULT_RATE,
  getModelRate,
  computeCredits,
  applyRateOverride,
} from "@/lib/quota/rates";

describe("model rates", () => {
  it("getModelRate returns a known model", () => {
    const rate = getModelRate("gpt-4o-mini");
    expect(rate.inputPerMillion).toBeGreaterThan(0);
    expect(rate.outputPerMillion).toBeGreaterThan(0);
  });

  it("falls back to the default rate for unknown models", () => {
    expect(getModelRate("some-future-model")).toEqual(DEFAULT_RATE);
  });

  it("covers the most common models", () => {
    expect(MODEL_RATES["gpt-4o"]).toBeDefined();
    expect(MODEL_RATES["gpt-4o-mini"]).toBeDefined();
    expect(MODEL_RATES["claude-3-5-sonnet-20241022"]).toBeDefined();
    expect(MODEL_RATES["o1"]).toBeDefined();
  });

  it("stores integer rates (no fractional table entries)", () => {
    for (const [model, rate] of Object.entries(MODEL_RATES)) {
      expect(Number.isInteger(rate.inputPerMillion), model).toBe(true);
      expect(Number.isInteger(rate.outputPerMillion), model).toBe(true);
    }
  });
});

describe("computeCredits", () => {
  it("charges gpt-4o-mini input at 15 积分 per 1M tokens", () => {
    // 1,000,000 input tokens = 15 积分 = 15,000 units
    const units = computeCredits({
      model: "gpt-4o-mini",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(units).toBe(15_000);
  });

  it("charges for mixed input and output", () => {
    // 1000 * 15 + 1000 * 60 = 75,000 / 1000 = 75 units = 0.075 积分
    const units = computeCredits({
      model: "gpt-4o-mini",
      promptTokens: 1000,
      completionTokens: 1000,
    });
    expect(units).toBe(75);
  });

  it("keeps sub-积分 precision for tiny requests", () => {
    // 11 prompt + 7 completion on gpt-4o-mini = 0.585 units → 1 unit = 0.001 积分
    const tiny = computeCredits({
      model: "gpt-4o-mini",
      promptTokens: 11,
      completionTokens: 7,
    });
    expect(tiny).toBe(1);

    // 100 * 15 / 1000 = 1.5, 200 * 60 / 1000 = 12 → 13.5 → 14 units
    const bigger = computeCredits({
      model: "gpt-4o-mini",
      promptTokens: 100,
      completionTokens: 200,
    });
    expect(bigger).toBe(14);
  });

  it("returns 0 for zero tokens", () => {
    expect(
      computeCredits({ model: "gpt-4o", promptTokens: 0, completionTokens: 0 }),
    ).toBe(0);
  });

  it("clamps negative token counts to zero", () => {
    expect(
      computeCredits({ model: "gpt-4o", promptTokens: -1000, completionTokens: -500 }),
    ).toBe(0);
  });

  it("uses the default rate for unknown models", () => {
    // 1000 tokens * 500 / 1000 = 500 units
    expect(
      computeCredits({ model: "totally-unknown", promptTokens: 1000, completionTokens: 0 }),
    ).toBe(500);
  });

  it("always returns a non-negative integer", () => {
    const units = computeCredits({
      model: "gpt-4o-mini",
      promptTokens: 333,
      completionTokens: 0,
    });
    expect(units).toBe(5); // 4.995 → 5
    expect(Number.isInteger(units)).toBe(true);
  });
});

describe("applyRateOverride", () => {
  it("applies per-million overrides", () => {
    applyRateOverride('{"custom-model":{"inputPerMillion":100,"outputPerMillion":200}}');
    expect(getModelRate("custom-model")).toEqual({
      inputPerMillion: 100,
      outputPerMillion: 200,
    });
  });

  it("accepts per-1k 积分 overrides", () => {
    applyRateOverride('{"legacy-model":{"inputPer1kCredits":0.1,"outputPer1kCredits":0.2}}');
    expect(getModelRate("legacy-model")).toEqual({
      inputPerMillion: 100,
      outputPerMillion: 200,
    });
  });

  it("ignores invalid JSON", () => {
    const before = getModelRate("gpt-4o");
    applyRateOverride("not json");
    expect(getModelRate("gpt-4o")).toEqual(before);
  });

  it("ignores entries with missing fields", () => {
    applyRateOverride('{"foo":{"inputPerMillion":100}}');
    expect(getModelRate("foo")).toBe(DEFAULT_RATE);
  });
});
