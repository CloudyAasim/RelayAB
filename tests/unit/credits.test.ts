/**
 * tests/unit/credits.test.ts
 *
 * 积分 unit helpers + formatting. Amounts are stored as integers in
 * 0.001-积分 units.
 */
import { describe, it, expect } from "vitest";
import { CREDIT_SCALE, creditsToUnits, unitsToCredits } from "@/lib/quota/credits";
import { formatCredits } from "@/lib/utils";

describe("积分 units", () => {
  it("stores 1000 units per 积分", () => {
    expect(CREDIT_SCALE).toBe(1000);
  });

  it("converts 积分 into storage units", () => {
    expect(creditsToUnits(1)).toBe(1000);
    expect(creditsToUnits(500)).toBe(500_000);
    expect(creditsToUnits(0.001)).toBe(1);
  });

  it("rounds fractional conversions to whole units", () => {
    expect(creditsToUnits(0.0000004)).toBe(0);
    expect(Number.isInteger(creditsToUnits(1.23456789))).toBe(true);
  });

  it("converts storage units back into 积分", () => {
    expect(unitsToCredits(1000)).toBe(1);
    expect(unitsToCredits(1)).toBeCloseTo(0.001, 10);
  });

  it("treats non-finite input as zero", () => {
    expect(creditsToUnits(Number.NaN)).toBe(0);
    expect(unitsToCredits(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatCredits", () => {
  it("formats whole amounts without decimals", () => {
    expect(formatCredits(500_000)).toBe("500");
    expect(formatCredits(1000)).toBe("1");
  });

  it("keeps up to 3 decimals for partial amounts", () => {
    expect(formatCredits(1234)).toBe("1.234");
    expect(formatCredits(1)).toBe("0.001");
  });

  it("formats zero", () => {
    expect(formatCredits(0)).toBe("0");
  });

  it("survives non-finite input", () => {
    expect(formatCredits(Number.NaN)).toBe("0");
  });
});
