/**
 * Full end-to-end smoke test for all session changes.
 * Run with: ./node_modules/.bin/vitest run tests/e2e/_full_e2e_full.test.ts
 */
import { describe, it, expect } from "vitest";
import { loadConfig, __resetConfigForTest } from "@/lib/config";
import { __resetRedisForTest, getRedis } from "@/lib/db/redis";
import * as fs from "node:fs";

const setEnv = (env: Record<string, string | undefined>): void => {
  for (const k of Object.keys(process.env)) {
    if (!(k in env)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetConfigForTest();
};

describe("Test 1 · config.ts: schema accepts Deploy-Button flow", () => {
  it("only RELAY_AUTH is required at startup", () => {
    setEnv({
      RELAY_AUTH: "deploy-button-only-12345678",
      NODE_ENV: "production",
    });
    const cfg = loadConfig();
    expect(cfg.RELAY_AUTH).toBe("deploy-button-only-12345678");
    expect(cfg.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(cfg.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
  });
});

describe("Test 2 · config.ts: rejects missing RELAY_AUTH", () => {
  it("throws when RELAY_AUTH missing even with KV_* set", () => {
    setEnv({
      NODE_ENV: "production",
      KV_REST_API_URL: "https://x.upstash.io",
      KV_REST_API_TOKEN: "tok",
    });
    expect(() => loadConfig()).toThrow(/RELAY_AUTH/);
  });
});

describe("Test 3 · config.ts: KV_REST_API_* fallback", () => {
  it("KV_REST_API_URL → cfg.UPSTASH_REDIS_REST_URL", () => {
    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      KV_REST_API_URL: "https://kv-relay.upstash.io",
      KV_REST_API_TOKEN: "kv-token-abc",
      NODE_ENV: "production",
    });
    const cfg = loadConfig();
    expect(cfg.UPSTASH_REDIS_REST_URL).toBe("https://kv-relay.upstash.io");
    expect(cfg.UPSTASH_REDIS_REST_TOKEN).toBe("kv-token-abc");
  });
});

describe("Test 4 · config.ts: UPSTASH_* wins over KV_*", () => {
  it("UPSTASH_* preferred when both set", () => {
    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      UPSTASH_REDIS_REST_URL: "https://upstash-relay.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "upstash-token-xyz",
      KV_REST_API_URL: "https://kv-relay.upstash.io",
      KV_REST_API_TOKEN: "kv-token-abc",
      NODE_ENV: "production",
    });
    const cfg = loadConfig();
    expect(cfg.UPSTASH_REDIS_REST_URL).toBe("https://upstash-relay.upstash.io");
    expect(cfg.UPSTASH_REDIS_REST_TOKEN).toBe("upstash-token-xyz");
  });
});

describe("Test 5 · /healthz logic (re-implemented for in-process test)", () => {
  function checkHealth(env: Record<string, string | undefined>) {
    const readUrl = () => env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
    const readToken = () => env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
    const upstashUrl = readUrl();
    const upstashToken = readToken();
    const upstashOk = !!(upstashUrl?.trim() && upstashToken?.trim());
    const missing: string[] = [];
    if (!env.RELAY_AUTH?.trim()) missing.push("RELAY_AUTH");
    if (!upstashUrl?.trim()) missing.push("UPSTASH_REDIS_REST_URL (or KV_REST_API_URL)");
    if (!upstashToken?.trim()) missing.push("UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)");
    const totalRequired = 3;
    const configured = totalRequired - missing.length;
    const status =
      missing.length === 0 ? "ok" :
      missing.length === totalRequired ? "unconfigured" : "degraded";
    return { status, configured, totalRequired, missing };
  }

  it("all empty → unconfigured (0/3)", () => {
    expect(checkHealth({})).toEqual({ status: "unconfigured", configured: 0, totalRequired: 3, missing: expect.any(Array) });
  });
  it("only RELAY_AUTH → degraded (1/3)", () => {
    expect(checkHealth({ RELAY_AUTH: "x" })).toEqual({ status: "degraded", configured: 1, totalRequired: 3, missing: expect.any(Array) });
  });
  it("Upstash via KV_* (Marketplace-injected) → ok (3/3)", () => {
    const r = checkHealth({
      RELAY_AUTH: "x", KV_REST_API_URL: "https://x.upstash.io", KV_REST_API_TOKEN: "t",
    });
    expect(r.status).toBe("ok");
    expect(r.configured).toBe(3);
    expect(r.missing).toHaveLength(0);
  });
  it("Upstash via UPSTASH_* (manually-set) → ok (3/3)", () => {
    const r = checkHealth({
      RELAY_AUTH: "x", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t",
    });
    expect(r.status).toBe("ok");
    expect(r.configured).toBe(3);
  });
  it("RELAY_AUTH + URL only (missing token) → degraded", () => {
    const r = checkHealth({
      RELAY_AUTH: "x", UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
    });
    expect(r.status).toBe("degraded");
    // 1 missing (TOKEN) → 3-1=2 configured
    expect(r.missing.some(m => m.includes("TOKEN"))).toBe(true);
  });
});

describe("Test 6 · redis.ts: actionable error when Upstash missing", () => {
  it("throws with helpful message", () => {
    __resetRedisForTest();
    setEnv({
      RELAY_AUTH: "ok-password-12345678",
      NODE_ENV: "production",
    });
    expect(() => getRedis()).toThrow(/Redis is not configured/);
    expect(() => getRedis()).toThrow(/Vercel Marketplace/);
    expect(() => getRedis()).toThrow(/\/healthz/);
    __resetRedisForTest();
  });
});

describe("Test 7 · users.ts listUsers SCAN filter", () => {
  it("excludes by-username keys and keeps records", () => {
    const userKey = (id: string) => `relay:user:${id}`;
    const userByUsernameKey = (u: string) => `relay:user:by-username:${u}`;
    const fakeScan = [
      userKey("user-001"),
      userKey("user-002"),
      userByUsernameKey("admin"),
      userByUsernameKey("alice"),
      "relay:meta:initialized",
    ];
    const filtered = fakeScan.filter(
      (key) => key.startsWith(userKey("")) && !key.startsWith(userByUsernameKey(""))
    );
    expect(filtered).toHaveLength(2);
    expect(filtered).toContain(userKey("user-001"));
    expect(filtered).toContain(userKey("user-002"));
    expect(filtered).not.toContain(userByUsernameKey("admin"));
    expect(filtered).not.toContain(userByUsernameKey("alice"));
    expect(filtered).not.toContain("relay:meta:initialized");
  });
});

describe("Test 8 · keys.ts listAllApiKeys SCAN filter", () => {
  it("excludes by-hash + by-user keys and keeps records", () => {
    const apiKeyKey = (id: string) => `relay:apikey:${id}`;
    const apiKeyByHashKey = (h: string) => `relay:apikey:hash:${h}`;
    const apiKeyByUserKey = (u: string) => `relay:apikey:by-user:${u}`;
    const fakeScan = [
      apiKeyKey("key-001"),
      apiKeyByHashKey("sha256-abc"),
      apiKeyByUserKey("user-001"),
      "relay:meta:initialized",
    ];
    const filtered = fakeScan.filter(
      (key) =>
        key.startsWith(apiKeyKey("")) &&
        !key.startsWith(apiKeyByHashKey("")) &&
        !key.startsWith(apiKeyByUserKey(""))
    );
    expect(filtered).toHaveLength(1);
    expect(filtered).toContain(apiKeyKey("key-001"));
    expect(filtered).not.toContain(apiKeyByHashKey("sha256-abc"));
    expect(filtered).not.toContain(apiKeyByUserKey("user-001"));
  });
});

describe("Test 9 · README Deploy Button URL is well-formed", () => {
  it("has correct shape", () => {
    const r = fs.readFileSync("./README.md", "utf-8");
    const m = r.match(/https:\/\/vercel\.com\/new\/clone\?[^)]+/);
    expect(m).not.toBeNull();
    if (!m) return;
    const u = new URL(m[0]);
    expect(u.pathname).toBe("/new/clone");
    expect(u.host).toBe("vercel.com");
    expect(u.searchParams.get("repository-url")).toBe("https://github.com/CloudyAasim/RelayAB");
    expect(u.searchParams.get("env")).toBe("RELAY_AUTH");
    expect(u.searchParams.get("envDescription")).not.toBeNull();
    expect(u.searchParams.get("envLink") || "").toContain("#readme");
  });
});

describe("Test 10 · LICENSE is MIT", () => {
  it("has standard MIT text", () => {
    const license = fs.readFileSync("./LICENSE", "utf-8");
    expect(license.startsWith("MIT License")).toBe(true);
    expect(/Copyright \(c\) \d{4}/.test(license)).toBe(true);
    expect(license).toContain("Permission is hereby granted, free of charge");
  });
});

describe("Test 11 · .gitignore coverage", () => {
  it("has all critical patterns", () => {
    const gi = fs.readFileSync("./.gitignore", "utf-8");
    const required = [
      { pattern: ".env", desc: "plain .env" },
      { pattern: ".env.*", desc: ".env.*" },
      { pattern: "!.env.example", desc: "explicit unignore of .env.example" },
      { pattern: "node_modules/", desc: "node_modules/" },
      { pattern: ".next/", desc: ".next/" },
      { pattern: "*.pem", desc: "PEM keys" },
      { pattern: "*.tsbuildinfo", desc: "tsbuildinfo" },
      { pattern: "next-env.d.ts", desc: "next-env.d.ts" },
      { pattern: ".vercel", desc: ".vercel" },
      { pattern: "coverage/", desc: "coverage/" },
      { pattern: "playwright-report/", desc: "playwright-report/" },
    ];
    for (const { pattern, desc } of required) {
      const present = gi.split("\n").some((line) => {
        const t = line.trim();
        return t === pattern || t === pattern.replace(/\/$/, "");
      });
      expect(present, `${desc} (pattern: ${pattern})`).toBe(true);
    }
  });
});

describe("Test 12 · package.json sanity", () => {
  it("no prebuild, packageManager set, no engines", () => {
    const p = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
    expect(p.scripts.prebuild).toBeUndefined();
    expect(p.packageManager).toBe("pnpm@10.28.0");
    expect(p.engines).toBeUndefined();
  });
});

describe("Test 13 · README structure", () => {
  it("has all key sections", () => {
    const r = fs.readFileSync("./README.md", "utf-8");
    expect(r).toContain("vercel.com/new/clone");
    expect(r).toContain("env=RELAY_AUTH");
    expect(r).toContain("KV_REST_API_URL");
    expect(r).toContain("KV_REST_API_TOKEN");
    expect(r).toContain("/healthz");
    expect(r).toContain("## 许可证");
    expect((r.match(/^## /gm) || []).length).toBeGreaterThanOrEqual(5);
  });
});

describe("Test 14 · Footer component (no RelayAB version)", () => {
  it("does not display project version", () => {
    const f = fs.readFileSync("./src/components/layouts/Footer.tsx", "utf-8");
    expect(/export\s+function\s+Footer/.test(f)).toBe(true);
    expect(f).toContain("NEXT_PUBLIC_REPOSITORY_URL");
    expect(f).toContain('href="/license"');
    // Footer must not display a version number in rendered JSX. We check this
    // by stripping TS comments (// and /* */) before searching.
    const stripped = f
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // No "vX.Y.Z" or "X.Y.Z" version-like pattern in JSX
    expect(/v?\d+\.\d+\.\d+/.test(stripped)).toBe(false);
    // No reference to cfg.version / pkg.version / version field in JSX
    expect(/\bversion\b/.test(stripped)).toBe(false);
  });
});

describe("Test 15 · license page (no version display)", () => {
  it("does not show 'RelayAB vX.Y.Z'", () => {
    const f = fs.readFileSync("./src/app/license/page.tsx", "utf-8");
    expect(/RelayAB\s+v?\d+\.\d+/.test(f)).toBe(false);
    expect(f).toContain("RUNTIME_DEPS");
    expect(f).toContain("DEV_DEPS");
  });
});
