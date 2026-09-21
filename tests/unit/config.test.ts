/**
 * tests/unit/config.test.ts
 *
 * Validates the simplified env-var schema:
 * - 3 required vars (RELAY_AUTH, UPSTASH_REDIS_REST_URL, _TOKEN)
 * - SESSION_PASSWORD and RELAY_MASTER_KEY_HEX are auto-derived
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadConfig,
  __resetConfigForTest,
  isProduction,
  isEmulatorEnabled,
  getMasterKey,
  getSessionPassword,
  getOpenAIKeys,
  getAnthropicKeys,
  isMasterKeyExplicit,
} from "@/lib/config";

describe("config", () => {
  beforeEach(() => {
    __resetConfigForTest();
  });

  it("loads valid test config and reuses cache", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it("only requires RELAY_AUTH + Upstash vars", () => {
    // The test setup provides these. Anything else is auto-defaulted.
    const cfg = loadConfig();
    expect(cfg.RELAY_AUTH.length).toBeGreaterThanOrEqual(8);
    expect(cfg.UPSTASH_REDIS_REST_URL).toMatch(/localhost|https:/);
    expect(cfg.UPSTASH_REDIS_REST_TOKEN.length).toBeGreaterThan(0);
  });

  it("throws helpful error when RELAY_AUTH is missing in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        UPSTASH_REDIS_REST_URL: "http://localhost:3000",
        UPSTASH_REDIS_REST_TOKEN: "x",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/RELAY_AUTH/);
  });

  it("throws helpful error when Upstash vars are missing", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        RELAY_AUTH: "long-enough-password-here",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/UPSTASH/);
  });

  it("EMULATE_VERCEL_LOCAL is coerced to boolean", () => {
    (process.env as Record<string, string>).EMULATE_VERCEL_LOCAL = "1";
    __resetConfigForTest();
    expect(isEmulatorEnabled()).toBe(true);

    (process.env as Record<string, string>).EMULATE_VERCEL_LOCAL = "0";
    __resetConfigForTest();
    expect(isEmulatorEnabled()).toBe(false);
  });

  it("isEmulatorEnabled returns false in production even when flag is on", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    (process.env as Record<string, string>).EMULATE_VERCEL_LOCAL = "1";
    __resetConfigForTest();
    expect(isEmulatorEnabled()).toBe(false);
  });

  it("isProduction reflects NODE_ENV", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    __resetConfigForTest();
    expect(isProduction()).toBe(true);

    (process.env as Record<string, string>).NODE_ENV = "test";
    __resetConfigForTest();
    expect(isProduction()).toBe(false);
  });

  describe("getMasterKey (auto-derived)", () => {
    it("returns 32-byte buffer derived from RELAY_AUTH", () => {
      __resetConfigForTest();
      const key = getMasterKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("is deterministic for the same RELAY_AUTH", () => {
      __resetConfigForTest();
      const a = getMasterKey();
      const b = getMasterKey();
      expect(a.equals(b)).toBe(true);
    });

    it("changes when RELAY_AUTH changes", () => {
      __resetConfigForTest();
      const before1 = getMasterKey().toString("hex");

      (process.env as Record<string, string>).RELAY_AUTH = "different-password-at-least-8-chars";
      __resetConfigForTest();
      const after = getMasterKey().toString("hex");

      expect(after).not.toBe(before1);
    });

    it("uses explicit RELAY_MASTER_KEY_HEX when set", () => {
      (process.env as Record<string, string>).RELAY_MASTER_KEY_HEX = "ab".repeat(32);
      __resetConfigForTest();
      expect(getMasterKey().toString("hex")).toBe("ab".repeat(32));
      expect(isMasterKeyExplicit()).toBe(true);

      delete process.env.RELAY_MASTER_KEY_HEX;
      __resetConfigForTest();
      expect(isMasterKeyExplicit()).toBe(false);
    });
  });

  describe("getSessionPassword (auto-derived)", () => {
    it("returns a string of sufficient length for iron-session", () => {
      __resetConfigForTest();
      expect(getSessionPassword().length).toBeGreaterThanOrEqual(32);
    });

    it("is deterministic for the same RELAY_AUTH", () => {
      __resetConfigForTest();
      expect(getSessionPassword()).toBe(getSessionPassword());
    });

    it("differs from the master key (different derivation labels)", () => {
      __resetConfigForTest();
      const session = getSessionPassword();
      const master = getMasterKey().toString("hex");
      expect(session).not.toBe(master);
    });
  });

  describe("env-var provider key parsing", () => {
    it("getOpenAIKeys splits comma-separated list", () => {
      (process.env as Record<string, string>).OPENAI_KEYS = "sk-1, sk-2 ,sk-3";
      __resetConfigForTest();
      expect(getOpenAIKeys()).toEqual(["sk-1", "sk-2", "sk-3"]);
    });

    it("getOpenAIKeys returns empty when unset", () => {
      delete process.env.OPENAI_KEYS;
      __resetConfigForTest();
      expect(getOpenAIKeys()).toEqual([]);
    });

    it("getAnthropicKeys splits comma-separated list", () => {
      (process.env as Record<string, string>).ANTHROPIC_KEYS = "sk-ant-1,sk-ant-2";
      __resetConfigForTest();
      expect(getAnthropicKeys()).toEqual(["sk-ant-1", "sk-ant-2"]);
    });
  });

  it("rejects malformed UPSTASH_REDIS_REST_URL", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        UPSTASH_REDIS_REST_URL: "not-a-url",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("rejects too-short RELAY_AUTH", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        RELAY_AUTH: "short",
      } as NodeJS.ProcessEnv),
    ).toThrow(/RELAY_AUTH/);
  });
});
