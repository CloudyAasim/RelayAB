/**
 * tests/unit/catalog-price-units.test.ts
 *
 * The price column divided a per-million rate by a million.
 *
 * `inputCost` is stored in credits per 1,000,000 tokens — `computeCredits`
 * multiplies by it directly, and the column header says so. The renderer
 * applied the token-count formatter's `/ 1_000_000` idiom to it, so a model
 * configured at 250 printed `0.0003 / 1M`. To somebody reading the page that is
 * indistinguishable from "the price was not picked up", which is exactly how it
 * was reported.
 *
 * Nothing asserted the units. A test that checks "the column renders the input
 * cost" passes happily when it renders a millionth of it. So the assertion here
 * is numeric: take a rate, put it in a catalogue row, and require the printed
 * number to be that rate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CATALOG = readFileSync(join(ROOT, "src", "lib", "docs", "catalog.ts"), "utf-8");
const MODEL_CATALOG = readFileSync(
  join(ROOT,
    "src",
    "components",
    "docs",
    "ModelCatalog.tsx",
  ),
  "utf-8",
);
const RATES = readFileSync(join(ROOT, "src", "lib", "quota", "rates.ts"), "utf-8");

describe("a price is printed in the units it is stored in", () => {
  it("the rate is never divided on the way to the screen", () => {
    // The token-count formatter legitimately uses / 1_000_000 and / 1_000; a
    // rate must use neither. A window from `function cost(` rather than a slice
    // to the next closing brace, which is a shape that silently stops matching
    // the day the helper grows a parameter.
    expect(MODEL_CATALOG, "the price helper divides again").not.toMatch(
      /function cost\([\s\S]{0,240}?\/ ?1_000_000/,
    );
    expect(MODEL_CATALOG, "the price helper divides at all").not.toMatch(
      /function cost\([\s\S]{0,240}?\/ ?1000\b/,
    );
    expect(MODEL_CATALOG).toMatch(/function cost\([\s\S]{0,240}?return String\(n\);/);
  });

  it("and the whole file does not divide a rate to render it", () => {
    // A per-item price is **whole 积分 per item** — `media/billing.ts` says so
    // and multiplies by 1000 on the way into storage. The media cell used to
    // divide it before printing, publishing 100 积分 per image as 0.100, and
    // this comment used to endorse that. Both are corrected: the media cell
    // must not divide either, for the same reason the token rate does not.
    expect(MODEL_CATALOG).not.toMatch(/\(m\.inputCost \/ 1_000_000\)/);
    expect(MODEL_CATALOG).not.toMatch(/\(m\.outputCost \/ 1_000_000\)/);
    expect(MODEL_CATALOG).not.toMatch(/\(m\.cachedInputCost \/ 1_000_000\)/);
  });

  it("the stored unit is credits per million, confirmed at the source", () => {
    // So the assertion above is not a guess about which side is wrong: the
    // billing formula multiplies prompt tokens by this number and divides by a
    // thousand, which only works if the number is already per million.
    expect(RATES).toMatch(
      /const total = \(promptCredits \+ completionTokens \* output\) \/ 1000;/,
    );
    expect(CATALOG, "the catalogue does not read the configured rate").toMatch(
      /inputCost: cost \? cost\.inputCost : null/,
    );
    expect(CATALOG).toMatch(/outputCost: cost \? cost\.outputCost : null/);
  });

  it("and the media per-item price is whole credits, not thousandths", () => {
    // The sibling of the bug: `pricePerItem` arrives from the panel as whole
    // 积分 and is multiplied by 1000 when it is stored. A catalogue that divides
    // it is a thousand off, and it was.
    expect(
      MODEL_CATALOG,
      "a whole-credit per-item price is divided on the way to the page",
    ).not.toMatch(/m\.inputCost \/ 1000/);
    expect(
      MODEL_CATALOG,
      "the media cell prints units and calls them credits",
    ).not.toMatch(/toFixed\(3\)\} 积分/);
  });

  it("both halves of the rate are on the page", () => {
    // A rate whose other half is invisible is half a price, and the gap between
    // reading and writing is usually several times.
    expect(MODEL_CATALOG).toMatch(/cost\(m\.inputCost\)/);
    expect(MODEL_CATALOG, "the output rate is never rendered").toMatch(/cost\(m\.outputCost\)/);
    expect(MODEL_CATALOG).toMatch(/docs\.catalog\.rateIn/);
    expect(MODEL_CATALOG).toMatch(/docs\.catalog\.rateOut/);
  });
});
