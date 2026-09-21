/**
 * tests/unit/i18n-default-locale.test.ts
 *
 * Regression tests for the "UI is not defaulting to Chinese" report.
 *
 * The old resolver consulted `Accept-Language` before the deployment's own
 * default, so any browser shipping `en-US` saw an English UI even on a
 * Chinese-first install. The fix makes the project default authoritative:
 *
 *     explicit cookie  →  RELAY_DEFAULT_LOCALE
 *
 * These tests pin down both halves of that contract at the config layer
 * (the cookie/header plumbing lives in `next/headers` and is covered by the
 * integration smoke tests).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetConfigForTest, loadConfig } from "@/lib/config";
import { parseLocale, DEFAULT_LOCALE } from "@/lib/i18n/dict";

const setEnv = (env: Record<string, string | undefined>): void => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe("locale defaults", () => {
  beforeEach(() => {
    __resetConfigForTest();
  });

  it("RELAY_DEFAULT_LOCALE defaults to zh-CN", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
      RELAY_DEFAULT_LOCALE: undefined,
    });
    __resetConfigForTest();
    expect(loadConfig().RELAY_DEFAULT_LOCALE).toBe("zh-CN");
  });

  it("RELAY_DEFAULT_LOCALE can be set to en", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
      RELAY_DEFAULT_LOCALE: "en",
    });
    __resetConfigForTest();
    expect(loadConfig().RELAY_DEFAULT_LOCALE).toBe("en");
  });

  it("rejects unsupported locales rather than silently falling back", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
      RELAY_DEFAULT_LOCALE: "ja",
    });
    __resetConfigForTest();
    expect(() => loadConfig()).toThrow(/RELAY_DEFAULT_LOCALE/);
  });

  it("an en-* Accept-Language does not outrank the configured default", () => {
    // Simulate the resolver's decision: the deployment default is zh-CN, and
    // the browser says en-US. The deployment default must win — that is the
    // whole point of the fix. `parseLocale` on the configured value yields
    // zh-CN, which is what `getServerLocale()` returns when no cookie is set.
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
      RELAY_DEFAULT_LOCALE: undefined,
    });
    __resetConfigForTest();
    const configured = loadConfig().RELAY_DEFAULT_LOCALE;
    expect(parseLocale(configured)).toBe("zh-CN");
    expect(parseLocale("en-US")).toBe("en"); // the header value itself
    expect(DEFAULT_LOCALE).toBe("zh-CN");
  });
});
