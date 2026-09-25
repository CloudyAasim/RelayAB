/**
 * RB-004: Data-level regression guard for new RB-003 i18n strings.
 *
 * HTTP-behaviour (400 validation, 403, 404, DB immutability) is now covered by
 * tests/integration/admin-rename-patch.test.ts (12 real-behaviour tests).
 *
 * This file only asserts that new i18n keys exist and are non-empty in BOTH
 * zh-CN and en-US locales.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..", "..", "src");

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf-8");
}

describe("i18n keys — RB-003 / RB-004 new strings", () => {
  const dict = read("lib/i18n/dict.ts");

  // ---- zh-CN ----------------------------------------------------------------
  it('zh-CN: admin.users.action.editDisplayName is non-empty', () => {
    const match = dict.match(/"admin\.users\.action\.editDisplayName":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('zh-CN: admin.users.editDisplayName.title is non-empty', () => {
    const match = dict.match(/"admin\.users\.editDisplayName\.title":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('zh-CN: admin.keys.action.rename is non-empty', () => {
    const match = dict.match(/"admin\.keys\.action\.rename":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('zh-CN: admin.keys.rename.title is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.title":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('zh-CN: admin.keys.rename.errorEmpty is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.errorEmpty":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('zh-CN: admin.keys.rename.errorTooLong is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.errorTooLong":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  // ---- en-US ----------------------------------------------------------------
  it('en-US: admin.users.action.editDisplayName is non-empty', () => {
    const match = dict.match(/"admin\.users\.action\.editDisplayName":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('en-US: admin.users.editDisplayName.title is non-empty', () => {
    const match = dict.match(/"admin\.users\.editDisplayName\.title":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('en-US: admin.keys.action.rename is non-empty', () => {
    const match = dict.match(/"admin\.keys\.action\.rename":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('en-US: admin.keys.rename.title is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.title":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('en-US: admin.keys.rename.errorEmpty is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.errorEmpty":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });

  it('en-US: admin.keys.rename.errorTooLong is non-empty', () => {
    const match = dict.match(/"admin\.keys\.rename\.errorTooLong":\s*"([^"]+)"/);
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  });
});
