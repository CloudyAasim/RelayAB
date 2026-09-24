/**
 * Pricing rules.
 *
 * A rate belongs to one **model row of one provider** — the client-facing model
 * id as mapped inside that provider. Two providers serving the same model name
 * therefore price it independently, and the same provider can price each of its
 * models differently. Rates are 积分 per 1,000,000 tokens; `computeCredits`
 * returns integer 0.001-积分 units.
 */
import { describe, it, expect } from "vitest";
import { FREE_RATE, computeCredits, resolveModelRate } from "@/lib/quota/rates";

/** A model row's rate fields (what `provider.modelConfigs[id]` holds). */
const model = (inputCost = 0, outputCost = 0) => ({ inputCost, outputCost });

describe("resolveModelRate", () => {
  it("is free when the model row has no rate configured", () => {
    expect(resolveModelRate()).toEqual(FREE_RATE);
    expect(resolveModelRate(null)).toEqual(FREE_RATE);
    expect(resolveModelRate(model())).toEqual(FREE_RATE);
  });

  it("reads the rate straight off the model row", () => {
    expect(resolveModelRate(model(12, 34))).toEqual({
      inputPerMillion: 12,
      outputPerMillion: 34,
    });
  });

  it("keeps input and output independent", () => {
    expect(resolveModelRate(model(12, 0))).toEqual({
      inputPerMillion: 12,
      outputPerMillion: 0,
    });
  });

  it("treats missing or nonsense values as 0", () => {
    expect(resolveModelRate(model(Number.NaN, -1))).toEqual(FREE_RATE);
  });
});

describe("computeCredits", () => {
  it("converts tokens × rate into 0.001-积分 units", () => {
    // 1000 prompt × 15 / 1000 = 15 units = 0.015 积分
    expect(
      computeCredits({
        rate: { inputPerMillion: 15, outputPerMillion: 60 },
        promptTokens: 1000,
        completionTokens: 0,
      }),
    ).toBe(15);
  });

  it("rounds to the nearest unit instead of up to a whole 积分", () => {
    // (10×15 + 20×60) / 1000 = 1.35 → 1 unit; a whole-积分 ledger would charge 1000
    const units = computeCredits({
      rate: { inputPerMillion: 15, outputPerMillion: 60 },
      promptTokens: 10,
      completionTokens: 20,
    });
    expect(units).toBe(1);
    expect(units).toBeLessThan(1000);
  });

  it("charges nothing for a free rate", () => {
    expect(
      computeCredits({ rate: FREE_RATE, promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ).toBe(0);
  });

  it("prices input and output separately", () => {
    // 1M input at 12 + 1M output at 34 = 12 + 34 = 46 积分 = 46000 units
    expect(
      computeCredits({
        rate: { inputPerMillion: 12, outputPerMillion: 34 },
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      }),
    ).toBe(46_000);
  });

  it("ignores negative or non-finite token counts", () => {
    const rate = { inputPerMillion: 100, outputPerMillion: 100 };
    expect(computeCredits({ rate, promptTokens: -5, completionTokens: Number.NaN })).toBe(0);
    expect(computeCredits({ rate, promptTokens: 10.7, completionTokens: 0 })).toBe(1);
  });
});
