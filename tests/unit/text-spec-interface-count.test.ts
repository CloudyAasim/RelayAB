/**
 * tests/unit/text-spec-interface-count.test.ts
 *
 * "四个接口都已配置。" sat under a list of three.
 *
 * The compatibility-interface list is a real array — `CONFIGURABLE_PROTOCOLS`
 * has three entries, the three that the gateway actually routes — but the line
 * that says "you have configured them all" spelled the number out in prose. It
 * read true when the fourth interface existed and kept saying it after that
 * one was removed with the `gemini-generate` preset, because nothing tied the
 * two together. The sibling string, "已配置 {n} 个接口", already took its
 * count as an argument; this one did not.
 *
 * So the guard is not "the number is three" — that would go stale the moment a
 * fourth surface is added, which is exactly how the bug got here. It is that
 * the sentence has no number of its own to go stale.
 *
 * These are source-level guards: the sentence is rendered by a client component
 * with no test-renderer in this project, and the defect was the text itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DICTS } from "@/lib/i18n/dict";
import { CONFIGURABLE_PROTOCOLS } from "@/lib/protocol/text-protocols";

const SRC = join(process.cwd(), "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf-8");

const FIELD = read("app/(admin)/admin/providers/TextProtocolField.tsx");

const KEY = "admin.textSpec.allAdded";

describe("the all-configured sentence", () => {
  it("takes its count as an argument in every locale", () => {
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const value = DICTS[locale][KEY];
      expect(value, `${locale} is missing ${KEY}`).toBeTruthy();
      expect(value, `${locale} hardcodes a count instead of interpolating`).toContain("{n}");
    }
  });

  it("spells out no count of its own in any locale", () => {
    // The literal that shipped. A number written into prose cannot be checked
    // against the array, which is how it outlived the fourth interface.
    for (const locale of Object.keys(DICTS) as (keyof typeof DICTS)[]) {
      const value = DICTS[locale][KEY];
      expect(value).not.toMatch(/四/);
      expect(value).not.toMatch(/\bfour\b/i);
    }
  });

  it("is handed the array's own length", () => {
    // Interpolating {n} is only half the fix; the caller still has to pass the
    // real length rather than a literal.
    expect(FIELD).toContain(`t("${KEY}", { n: CONFIGURABLE_PROTOCOLS.length })`);
  });

  it("agrees with the list it is describing", () => {
    // Guards the two halves together: the sentence says "all N", and the
    // buttons that reveal it disappear exactly when all N are present. The
    // filter is by what is used AND by which face is on, because an interface
    // under a switched-off face is not offered at all.
    const filter = FIELD.match(/CONFIGURABLE_PROTOCOLS\.filter\(\(p\) => !used\.has\(p\) && faceOn\(p\)\)/);
    expect(filter, "the add-buttons filter is gone; this guard needs updating").toBeTruthy();
    expect(CONFIGURABLE_PROTOCOLS.length).toBeGreaterThan(0);
  });
});
