/**
 * The admin overview is the only surface where the billing mode is visible.
 * These are markup invariants (same style as the other `*-invariants` tests):
 * they pin the wiring so a later refactor cannot quietly drop the column and
 * leave estimated rows indistinguishable from measured ones.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const PAGE = readFileSync(join(ROOT, "src/app/(admin)/admin/page.tsx"), "utf-8");
const USAGE = readFileSync(join(ROOT, "src/lib/db/usage.ts"), "utf-8");
const DICT = readFileSync(join(ROOT, "src/lib/i18n/dict.ts"), "utf-8");

describe("admin overview: recent usage table", () => {
  it("reads recent usage across keys", () => {
    expect(PAGE).toContain("listRecentUsage");
    expect(USAGE).toContain("export async function listRecentUsage");
  });

  it("renders a billing-mode column", () => {
    expect(PAGE).toContain('t("admin.overview.billingMode")');
    expect(PAGE).toContain('t("admin.overview.recentUsage")');
  });

  it("distinguishes estimated from measured rows", () => {
    expect(PAGE).toMatch(/billingMode === "estimated"/);
    expect(PAGE).toContain('t("admin.overview.billingEstimated")');
    expect(PAGE).toContain('t("admin.overview.billingMeasured")');
  });

  it("localizes every new key in both dictionaries", () => {
    for (const key of [
      "admin.overview.recentUsage",
      "admin.overview.recentUsageDesc",
      "admin.overview.recentUsageEmpty",
      "admin.overview.billingMode",
      "admin.overview.billingMeasured",
      "admin.overview.billingEstimated",
      "admin.overview.billingFailed",
    ]) {
      const occurrences = DICT.split(`"${key}":`).length - 1;
      expect(occurrences, `${key} should exist in zh-CN and en`).toBe(2);
    }
  });
});
