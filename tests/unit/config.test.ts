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
  getDbPath,
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

  it("only requires RELAY_AUTH to load config successfully", () => {
    // Upstash vars are optional at startup — auto-injected by Vercel Marketplace.
    const cfg = loadConfig();
    expect(cfg.RELAY_AUTH.length).toBeGreaterThanOrEqual(8);
  });

  it("loads without Upstash creds when only RELAY_AUTH is set", () => {
    // Realistic Vercel scenario: Deploy Button deployed with RELAY_AUTH only,
    // Only RELAY_AUTH is required; the database needs no configuration at all.
    const cfg = loadConfig({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.RELAY_AUTH).toBe("long-enough-password-here");
    expect(cfg.RELAY_DB_PATH).toBeUndefined();
  });

  it("throws helpful error when RELAY_AUTH is missing", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        RELAY_DB_PATH: ":memory:",
        RELAY_PUBLIC_URL: "https://relay.example.com",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/RELAY_AUTH/);
  });

  it("RELAY_DB_PATH resolves, defaulting to the in-memory store", () => {
    // No database configuration is required — an unset path means SQLite
    // `:memory:`, which is what makes local dev and the test suite work with
    // zero setup.
    delete (process.env as Record<string, string>).RELAY_DB_PATH;
    __resetConfigForTest();
    expect(getDbPath()).toBe(":memory:");

    (process.env as Record<string, string>).RELAY_DB_PATH = "/var/lib/relayab/relayab.db";
    __resetConfigForTest();
    expect(getDbPath()).toBe("/var/lib/relayab/relayab.db");
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

  it("treats an empty RELAY_DB_PATH as unset rather than as a path", () => {
    // An env file ending in `RELAY_DB_PATH=` should not be read as "open the
    // database at the empty relative path" — it has to fall back to the
    // default, which is how every other optional variable behaves.
    const cfg = loadConfig({
      ...process.env,
      RELAY_DB_PATH: "",
    } as NodeJS.ProcessEnv);
    expect(cfg.RELAY_DB_PATH).toBeUndefined();
    expect(cfg.RELAY_AUTH).toBeDefined();
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
