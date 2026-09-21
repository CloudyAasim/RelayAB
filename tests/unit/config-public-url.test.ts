/**
 * tests/unit/config-public-url.test.ts
 *
 * Tests the RELAY_PUBLIC_URL configuration:
 *   - default in dev / test
 *   - required in production
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

  it("defaults to http://localhost:3000 in non-prod", () => {
    setEnv({
      RELAY_AUTH: "long-enough-password-here",
      NODE_ENV: "development",
    });
    __resetConfigForTest();
    const cfg = loadConfig();
    expect(cfg.RELAY_PUBLIC_URL).toBe("http://localhost:3000");
    expect(getPublicUrl()).toBe("http://localhost:3000");
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
