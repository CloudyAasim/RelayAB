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
  // Scope each locale to its own object. Matching the whole file would let a
  // key present in zh pass the en assertion, which is the one thing these
  // tests exist to catch.
  const zh = dict.slice(0, dict.indexOf("const en: Dict = {"));
  const en = dict.slice(dict.indexOf("const en: Dict = {"));

  function nonEmpty(block: string, key: string): void {
    const match = block.match(new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`));
    expect(match?.[1]?.trim().length).toBeGreaterThan(0);
  }

  // ---- zh-CN ----------------------------------------------------------------
  it('zh-CN: admin.users.config.* are non-empty', () => {
    nonEmpty(zh, "admin.users.config.title");
    nonEmpty(zh, "admin.users.config.open");
    nonEmpty(zh, "admin.users.config.identity");
  });

  it('zh-CN: admin.keys.rename.* are non-empty', () => {
    nonEmpty(zh, "admin.keys.action.rename");
    nonEmpty(zh, "admin.keys.rename.title");
    nonEmpty(zh, "admin.keys.rename.errorEmpty");
    nonEmpty(zh, "admin.keys.rename.errorTooLong");
  });

  // ---- en-US ----------------------------------------------------------------
  it('en-US: admin.users.config.* are non-empty', () => {
    nonEmpty(en, "admin.users.config.title");
    nonEmpty(en, "admin.users.config.open");
    nonEmpty(en, "admin.users.config.identity");
  });

  it('en-US: admin.keys.rename.* are non-empty', () => {
    nonEmpty(en, "admin.keys.action.rename");
    nonEmpty(en, "admin.keys.rename.title");
    nonEmpty(en, "admin.keys.rename.errorEmpty");
    nonEmpty(en, "admin.keys.rename.errorTooLong");
  });
});
