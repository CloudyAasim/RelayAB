/**
 * tests/unit/redis-client.test.ts
 *
 * Verifies that the singleton Redis client:
 * - Uses the in-memory mock under NODE_ENV=test
 * - Returns the same instance on repeat calls
 * - Can be reset between tests
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getRedis,
  __resetRedisForTest,
  __setRedisForTest,
  k,
  KEY_PREFIX,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";

describe("redis client singleton", () => {
  beforeEach(() => {
    __resetRedisForTest();
  });

  it("returns a singleton", () => {
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
  });

  it("uses in-memory mock under test environment", async () => {
    const r = getRedis();
    await r.set("test", "world");
    expect(await r.get("test")).toBe("world");
  });

  it("respects explicit mock injection", async () => {
    const fresh = createMemoryRedis();
    __setRedisForTest(fresh);
    const r = getRedis();
    await r.set("foo", "bar");
    expect(await fresh.get("foo")).toBe("bar");
  });
});

describe("key naming", () => {
  it("prefixes all keys with relay:", () => {
    expect(k.user("01J")).toBe("relay:user:01J");
    expect(k.apiKeyByHash("abc")).toBe("relay:apikey:hash:abc");
    expect(k.provider("p1")).toBe("relay:provider:p1");
    expect(k.usageLog("k1", "l1")).toBe("relay:log:k1:l1");
    expect(KEY_PREFIX).toBe("relay:");
  });
});
