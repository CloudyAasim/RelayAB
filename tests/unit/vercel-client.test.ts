/**
 * tests/unit/vercel-client.test.ts
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  vercelBaseUrl,
  getVercelClient,
  __resetVercelClientForTest,
  bypassHeaders,
} from "@/lib/vercel/client";

describe("vercelBaseUrl", () => {
  it("returns api.vercel.com when not emulating", () => {
    expect(vercelBaseUrl({ isEmulator: false })).toBe("https://api.vercel.com");
  });
  it("returns localhost emulator URL when emulating", () => {
    expect(vercelBaseUrl({ isEmulator: true })).toBe(
      "http://localhost:3000/api/_emu/vercel",
    );
    expect(vercelBaseUrl({ isEmulator: true, port: 8080 })).toBe(
      "http://localhost:8080/api/_emu/vercel",
    );
  });
});

describe("getVercelClient", () => {
  beforeEach(() => {
    __resetVercelClientForTest();
    process.env.VERCEL_TOKEN = "test-token";
  });

  it("returns a cached client for the same token", () => {
    const a = getVercelClient();
    const b = getVercelClient();
    expect(a).toBe(b);
  });

  it("rebuilds when the token changes", () => {
    const a = getVercelClient();
    const b = getVercelClient("another-token");
    expect(a).not.toBe(b);
  });
});

describe("bypassHeaders", () => {
  it("returns undefined when no secret configured", () => {
    delete process.env.VERCEL_PROTECTION_BYPASS;
    expect(bypassHeaders()).toBeUndefined();
  });
  it("returns the bypass header when secret configured", () => {
    process.env.VERCEL_PROTECTION_BYPASS = "my-secret";
    expect(bypassHeaders()).toEqual({
      "x-vercel-protection-bypass": "my-secret",
    });
  });
});
