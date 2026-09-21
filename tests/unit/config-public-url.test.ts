/**
 * tests/unit/config-public-url.test.ts
 *
 * Tests public-URL resolution:
 *   - RELAY_PUBLIC_URL is OPTIONAL; omitting it must not fail startup
 *   - VERCEL_URL is used as the fallback (no configuration on Vercel)
 *   - getPublicUrl() strips trailing slash
 *   - publicUrl() helper builds paths correctly
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetConfigForTest,
  loadConfig,
  getPublicUrl,
  publicUrl,
} from "@/lib/config";

const setEnv = (env: Record<string, string | undefined>): void => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe("RELAY_PUBLIC_URL config", () => {
  beforeEach(() => {
    __resetConfigForTest();
  });

  it("is OPTIONAL — omitting it does not fail startup", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: undefined,
      VERCEL_URL: undefined,
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    const cfg = loadConfig();
    // The schema accepts its absence; the value is derived at render time.
    expect(cfg.RELAY_PUBLIC_URL).toBeUndefined();
    // Env-only fallback is localhost, which is honest about not knowing.
    expect(getPublicUrl()).toBe("http://localhost:3000");
  });

  it("derives from VERCEL_URL with no configuration", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: undefined,
      VERCEL_URL: "relay-ab-abc123.vercel.app",
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    expect(getPublicUrl()).toBe("https://relay-ab-abc123.vercel.app");
  });

  it("prefers an explicit RELAY_PUBLIC_URL over VERCEL_URL", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      VERCEL_URL: "relay-ab-abc123.vercel.app",
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    expect(getPublicUrl()).toBe("https://relay.example.com");
  });

  it("strips trailing slash from the URL", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com/",
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    expect(getPublicUrl()).toBe("https://relay.example.com");
  });

  it("publicUrl() builds correct paths", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "https://relay.example.com",
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    expect(publicUrl("/v1")).toBe("https://relay.example.com/v1");
    expect(publicUrl("v1/chat/completions")).toBe("https://relay.example.com/v1/chat/completions");
  });

  it("rejects non-http(s) URLs in production (other than localhost)", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      RELAY_PUBLIC_URL: "ftp://relay.example.com",
      NODE_ENV: "production",
    });
    __resetConfigForTest();
    expect(() => loadConfig()).toThrow(/RELAY_PUBLIC_URL/);
  });
});
