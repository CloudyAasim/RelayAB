/**
 * tests/unit/credit-units.test.ts
 *
 * The unit invariant, checked by arithmetic rather than by reading comments.
 *
 * Two different numbers both get called "price", and the difference is a
 * thousand:
 *
 *   - a **token rate** is credits per *million* tokens, so billing multiplies by
 *     the token count and divides by 1000 to reach the 0.001-credit units that
 *     are actually stored;
 *   - a **per-item price** is *whole* credits, so the media billing path
 *     multiplies by 1000 to reach those same units.
 *
 * The catalogue read the second and divided it — publishing 100 积分 per image as
 * 0.100 积分. A guard that only matched source text would not have caught it,
 * because the dividing line was short, plausible and next to a matching one in
 * the token path. So the checks here are: a number priced at a hundred must read
 * as a hundred everywhere it is displayed, and the two multipliers must not
 * appear on the same value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCredits } from "@/lib/quota/rates";
import { computeMediaCredits } from "@/lib/media/billing";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const CATALOG_VIEW = read("src", "components", "docs", "ModelCatalog.tsx");
const DOC_CATALOG = read("src", "lib", "docs", "catalog.ts");
const RATES = read("src", "lib", "quota", "rates.ts");

describe("the two prices are not the same number", () => {
  it("a token rate is per million, so a million tokens costs the rate", () => {
    // 250 credits per million, one million tokens in: 250 credits, stored as
    // 250_000 units. A rate divided a second time here would bill a third of a
    // credit.
    const units = computeCredits({
      promptTokens: 1_000_000,
      completionTokens: 0,
      rate: { inputPerMillion: 250, outputPerMillion: 250 },
    });
    expect(units).toBe(250_000);
  });

  it("a per-item price is whole credits, so one image costs the price", () => {
    // 100 积分 per image → 100 credits → 100_000 units. The inverse error is
    // just as bad: storing 100 as 100 units would bill a thousandth.
    expect(computeMediaCredits(100, 1)).toBe(100_000);
  });

  it("and each one gets exactly one conversion", () => {
    // The shape of the bug class: a rate divided on the way in *and* on the way
    // out. One conversion in the token path, counted in code rather than in the
    // comment above it that also writes "/ 1000".
    const code = RATES.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/\/ 1000/g) ?? [], "a rate converted twice").toHaveLength(1);
    // The media side is not asserted by its text — it multiplies through a named
    // scale constant, which is better than a literal, so the check that matters
    // is the arithmetic above and not how the constant is spelled.
  });
});

describe("nothing divides a price on its way to a reader", () => {
  it("the token rate is printed as stored", () => {
    // `cost()` renders the number as it is; the header carries the unit.
    expect(CATALOG_VIEW, "the token rate is divided before it is printed").not.toMatch(
      /m\.inputCost \/ 1000/,
    );
    expect(CATALOG_VIEW, "the output rate is divided before it is printed").not.toMatch(
      /m\.outputCost \/ 1000/,
    );
  });

  it("and the per-item price is printed whole", () => {
    // The one that was wrong: `pricePerItem` reaches the catalogue as whole
    // credits, exactly as the operator typed it.
    expect(DOC_CATALOG, "the catalogue stores a converted per-item price").not.toMatch(
      /pricePerItem[\s\S]{0,80}?\/ 1000/,
    );
    expect(CATALOG_VIEW).not.toMatch(/toFixed\(3\)\} 积分/);
  });

  it("and the catalogue does not convert on the way in either", () => {
    // Reading a rate and dividing it is the same mistake one layer earlier.
    expect(DOC_CATALOG).not.toMatch(/inputCost:[\s\S]{0,120}?\/ 1000/);
    expect(DOC_CATALOG).not.toMatch(/cachedInputCost[\s\S]{0,160}?\/ 1000/);
  });
});
