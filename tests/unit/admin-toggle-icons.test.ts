/**
 * tests/unit/admin-toggle-icons.test.ts
 *
 * The enable and disable buttons in the admin panels are **icon-only**, and
 * they used to be the same icon: one `Power` glyph that meant "turn it on" in
 * one row and "turn it off" in the next, with the difference living only in the
 * tooltip. A reader glancing at the row had no way to tell which of the two
 * opposite actions the button would do.
 *
 * The fix is two different glyphs — the icon shows the **action**, and the
 * title spells it out — so the button is readable without hovering it.
 *
 * This file pins that, because a button that means two things is a thing
 * nobody notices is wrong.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

const SEARCH_ACTIONS = read(
  "src",
  "app",
  "(admin)",
  "admin",
  "search",
  "SearchProviderActions.tsx",
);
const MEDIA_ACTIONS = read(
  "src",
  "app",
  "(admin)",
  "admin",
  "media-providers",
  "MediaProviderActions.tsx",
);

describe("the enable/disable button is readable without hovering it", () => {
  it("the search providers' button shows two different icons", () => {
    // The row that is on offers "turn it off" and the row that is off offers
    // "turn it on" — so the two must not be the same glyph.
    expect(SEARCH_ACTIONS).toContain("PowerOff");
    expect(SEARCH_ACTIONS).toContain("Power");
    // And the choice is made on the state, not on a constant.
    expect(SEARCH_ACTIONS).toMatch(
      /provider\.enabled\s*\?\s*<PowerOff[\s\S]{0,80}:\s*<Power/,
    );
  });

  it("and the media providers' button, which had the same shape", () => {
    expect(MEDIA_ACTIONS).toContain("PowerOff");
    expect(MEDIA_ACTIONS).toMatch(
      /provider\.enabled\s*\?\s*<PowerOff[\s\S]{0,80}:\s*<Power/,
    );
  });

  it("and both spell the action out in the title as well", () => {
    for (const source of [SEARCH_ACTIONS, MEDIA_ACTIONS]) {
      expect(source).toMatch(/title=\{[\s\S]{0,120}disable[\s\S]{0,120}enable/);
      // An accessible name too: an icon-only button with no label is a button
      // a screen reader announces as nothing.
      expect(source).toContain("aria-label=");
    }
  });
});
