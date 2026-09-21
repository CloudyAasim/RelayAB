/**
 * tests/unit/memory-redis.test.ts
 *
 * Validates the in-memory Redis mock that backs our tests. It must
 * faithfully implement the subset of Upstash commands we depend on.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";

describe("memory-redis", () => {
  let r: ReturnType<typeof createMemoryRedis>;

  beforeEach(() => {
    r = createMemoryRedis();
  });

  it("string get/set/del", async () => {
    expect(await r.get("foo")).toBeNull();
    await r.set("foo", "bar");
    expect(await r.get("foo")).toBe("bar");
    expect(await r.del("foo")).toBe(1);
    expect(await r.get("foo")).toBeNull();
  });

  it("exists returns count of existing keys", async () => {
    await r.set("a", "x");
    await r.set("b", "y");
    expect(await r.exists("a", "b", "c")).toBe(2);
  });

  it("expire causes key to disappear on next read", async () => {
    await r.set("ttl", "v");
    await r.expire("ttl", 0);
    // expire(0) sets expireAt to Date.now() which already passed
    expect(await r.exists("ttl")).toBe(0);
  });

  it("hash operations", async () => {
    await r.hset("h", { a: "1", b: "2" });
    expect(await r.hget("h", "a")).toBe("1");
    expect(await r.hgetall("h")).toEqual({ a: "1", b: "2" });
    expect(await r.hincrby("h", "a", 5)).toBe(6);
    expect(await r.hdel("h", "b")).toBe(1);
  });

  it("set operations", async () => {
    await r.sadd("s", "x", "y", "z");
    expect(await r.sismember("s", "x")).toBe(1);
    expect(await r.smembers("s")).toEqual(["x", "y", "z"]);
    expect(await r.srem("s", "x")).toBe(1);
    expect(await r.smembers("s")).toEqual(["y", "z"]);
  });

  it("list operations (lpush, lrange, ltrim)", async () => {
    await r.lpush("l", "1", "2", "3"); // [3,2,1]
    expect(await r.lrange("l", 0, -1)).toEqual(["3", "2", "1"]);
    await r.ltrim("l", 0, 0);
    expect(await r.llen("l")).toBe(1);
    expect(await r.lrange("l", 0, -1)).toEqual(["3"]);
  });

  it("incr and decrby", async () => {
    expect(await r.incr("n")).toBe(1);
    expect(await r.incr("n")).toBe(2);
    expect(await r.decrby("n", 1)).toBe(1);
  });

  it("scan matches by glob pattern", async () => {
    await r.set("relay:user:1", "a");
    await r.set("relay:user:2", "b");
    await r.set("relay:apikey:1", "c");
    const [, keys] = await r.scan(0, { match: "relay:user:*" });
    expect(keys.sort()).toEqual(["relay:user:1", "relay:user:2"]);
  });

  it("WRONGTYPE on kind mismatch", async () => {
    await r.set("k", "v");
    await expect(r.smembers("k")).rejects.toThrow(/WRONGTYPE/);
  });
});
