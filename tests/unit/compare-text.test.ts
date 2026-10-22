/**
 * tests/unit/compare-text.test.ts
 *
 * The CI gate caught this: a test that asserted the reading order of the
 * operator's own documentation passed on a Windows machine (Chinese locale,
 * pinyin order) and failed on the runner (no UTF-8 locale, code point order).
 *
 * `localeCompare` with no locale follows the *ambient* locale, so the same
 * deployment sorted its pages differently depending on where it ran. The fix
 * is `compareText`, which compares by code point and therefore answers the
 * same on every machine.
 */
import { describe, it, expect } from "vitest";
import { compareText } from "@/lib/utils";

describe("compareText", () => {
  it("does not do pinyin, because pinyin depends on the machine", () => {
    // 杂 (U+6742) < 限 (U+9650) by code point. A Chinese locale would sort
    // 限流 (liàn) before 杂记 (zá) — the runner and the dev machine would
    // then disagree about the order of the same document.
    expect(compareText("杂记", "限流")).toBeLessThan(0);
    expect(compareText("限流", "杂记")).toBeGreaterThan(0);
  });

  it("ignores case for Latin text, the way a reader expects", () => {
    expect(compareText("apple", "Banana")).toBeLessThan(0);
    expect(compareText("Banana", "apple")).toBeGreaterThan(0);
    expect(compareText("Apple", "apple")).toBe(0);
  });

  it("says two equal things are equal", () => {
    expect(compareText("选型建议", "选型建议")).toBe(0);
  });

  it("gives the same answer whatever order the rows arrived in", () => {
    const titles = ["限流", "选型建议", "杂记", "附录"];
    const once = [...titles].sort(compareText);
    const shuffled = [...titles].reverse().sort(compareText);
    expect(shuffled).toEqual(once);
  });
});
