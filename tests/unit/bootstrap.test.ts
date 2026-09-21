/**
 * tests/unit/bootstrap.test.ts
 *
 * Tests the simplified auto-bootstrap flow:
 * - Creates admin from RELAY_AUTH on first invocation
 * - Is idempotent (running 10× = running once)
 * - Auto-seeds OpenAI providers from OPENAI_KEYS
 * - Auto-seeds Anthropic providers from ANTHROPIC_KEYS
 * - Skips already-existing providers
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { __resetConfigForTest } from "@/lib/config";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  runBootstrap,
  ensureBootstrapped,
  __resetBootstrapForTest,
  OPENAI_DEFAULT_MAPPING,
  ANTHROPIC_DEFAULT_MAPPING,
} from "@/lib/db/bootstrap";
import type { RedisLike } from "@/lib/db/__mocks__/memory-redis";
import { listUsers, verifyUserCredentials } from "@/lib/db/users";
import { listProviders } from "@/lib/db/providers";
import { getOpenAIKeys, getAnthropicKeys } from "@/lib/config";

describe("bootstrap - first run", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    delete process.env.OPENAI_KEYS;
    delete process.env.ANTHROPIC_KEYS;
    __resetConfigForTest();
  });

  it("creates an admin from RELAY_AUTH when no users exist", async () => {
    const r = await runBootstrap();
    expect(r.adminCreated).toBe(true);

    const { users } = await listUsers({ limit: 10 });
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("admin");

    // Password should match RELAY_AUTH (from setup.ts).
    const valid = await verifyUserCredentials(users[0].username, process.env.RELAY_AUTH!);
    expect(valid).not.toBeNull();
  });

  it("is idempotent — running twice doesn't create duplicates", async () => {
    const r1 = await runBootstrap();
    expect(r1.adminCreated).toBe(true);

    const r2 = await runBootstrap();
    expect(r2.adminCreated).toBe(false);

    const { users } = await listUsers({ limit: 10 });
    expect(users).toHaveLength(1);
  });

  it("uses RELAY_ADMIN_USERNAME env var when provided", async () => {
    (process.env as Record<string, string>).RELAY_ADMIN_USERNAME = "owner";
    const r = await runBootstrap();
    expect(r.adminCreated).toBe(true);
    const { users } = await listUsers({ limit: 1 });
    expect(users[0].username).toBe("owner");
  });
});

describe("bootstrap - provider seeding", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    delete process.env.OPENAI_KEYS;
    delete process.env.ANTHROPIC_KEYS;
    __resetConfigForTest();
  });

  it("creates one OpenAI provider per OPENAI_KEYS entry", async () => {
    (process.env as Record<string, string>).OPENAI_KEYS = "sk-1,sk-2";
    const r = await runBootstrap();
    expect(r.openaiProvidersCreated).toBe(2);

    const providers = await listProviders();
    const openaiOnly = providers.filter((p) => p.kind === "openai");
    expect(openaiOnly).toHaveLength(2);
    expect(openaiOnly[0].modelMapping).toEqual(OPENAI_DEFAULT_MAPPING);
  });

  it("creates one Anthropic provider per ANTHROPIC_KEYS entry", async () => {
    (process.env as Record<string, string>).ANTHROPIC_KEYS = "sk-ant-1,sk-ant-2";
    const r = await runBootstrap();
    expect(r.anthropicProvidersCreated).toBe(2);

    const providers = await listProviders();
    const antOnly = providers.filter((p) => p.kind === "anthropic");
    expect(antOnly).toHaveLength(2);
    expect(antOnly[0].modelMapping).toEqual(ANTHROPIC_DEFAULT_MAPPING);
  });

  it("honors OPENAI_BASE_URL override", async () => {
    (process.env as Record<string, string>).OPENAI_KEYS = "sk-1";
    (process.env as Record<string, string>).OPENAI_BASE_URL = "https://proxy.example.com/v1";
    await runBootstrap();

    const providers = await listProviders();
    const p = providers.find((x) => x.kind === "openai");
    expect(p?.baseUrl).toBe("https://proxy.example.com/v1");
  });

  it("skips bootstrap when providers already exist", async () => {
    (process.env as Record<string, string>).OPENAI_KEYS = "sk-1";
    const r1 = await runBootstrap();
    expect(r1.openaiProvidersCreated).toBe(1);

    // Run again — should NOT add a duplicate.
    (process.env as Record<string, string>).OPENAI_KEYS = "sk-2,sk-3";
    const r2 = await runBootstrap();
    expect(r2.openaiProvidersCreated).toBe(0);

    const providers = await listProviders();
    expect(providers.filter((p) => p.kind === "openai")).toHaveLength(1);
  });

  it("no-op when no provider keys are configured", async () => {
    const r = await runBootstrap();
    expect(r.openaiProvidersCreated).toBe(0);
    expect(r.anthropicProvidersCreated).toBe(0);

    const providers = await listProviders();
    expect(providers).toHaveLength(0);
  });
});

describe("bootstrap - master key warning", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    __resetConfigForTest();
  });

  it("warns when master key is derived (no explicit override)", async () => {
    delete process.env.RELAY_MASTER_KEY_HEX;
    const r = await runBootstrap();
    expect(r.masterKeyWarning).toBe(true);
  });

  it("does not warn when master key is explicitly set", async () => {
    (process.env as Record<string, string>).RELAY_MASTER_KEY_HEX = "ab".repeat(32);
    const r = await runBootstrap();
    expect(r.masterKeyWarning).toBe(false);
  });
});

describe("ensureBootstrapped - memoized runtime entry point", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    __resetBootstrapForTest();
    delete process.env.OPENAI_KEYS;
    delete process.env.ANTHROPIC_KEYS;
    __resetConfigForTest();
  });

  it("creates the admin on first call and memoizes the result", async () => {
    const first = await ensureBootstrapped();
    expect(first.adminCreated).toBe(true);

    const second = await ensureBootstrapped();
    expect(second).toBe(first); // same memoized object → runBootstrap ran once

    const { users } = await listUsers({ limit: 10 });
    expect(users).toHaveLength(1);
  });

  it("does not duplicate the admin when called concurrently", async () => {
    const results = await Promise.all([
      ensureBootstrapped(),
      ensureBootstrapped(),
      ensureBootstrapped(),
    ]);
    expect(results[0]).toBe(results[2]);

    const { users } = await listUsers({ limit: 10 });
    expect(users).toHaveLength(1);
  });

  it("retries after a transient failure instead of caching the error", async () => {
    const broken: RedisLike = new Proxy({} as RedisLike, {
      get: () => () => {
        throw new Error("redis unavailable");
      },
    });
    __setRedisForTest(broken);

    await expect(ensureBootstrapped()).rejects.toThrow("redis unavailable");

    __setRedisForTest(createMemoryRedis());
    const retry = await ensureBootstrapped();
    expect(retry.adminCreated).toBe(true);
  });
});

describe("env-var key parsing", () => {
  beforeEach(() => {
    __resetConfigForTest();
    delete process.env.OPENAI_KEYS;
    delete process.env.ANTHROPIC_KEYS;
  });

  it("getOpenAIKeys splits comma-separated values", () => {
    (process.env as Record<string, string>).OPENAI_KEYS = "a,b,c";
    expect(getOpenAIKeys()).toEqual(["a", "b", "c"]);
  });

  it("getAnthropicKeys splits comma-separated values", () => {
    (process.env as Record<string, string>).ANTHROPIC_KEYS = "x,y";
    expect(getAnthropicKeys()).toEqual(["x", "y"]);
  });
});
