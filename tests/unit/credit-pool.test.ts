/**
 * tests/unit/credit-pool.test.ts
 *
 * Locks down the central modelling decision of the gateway: a quota pool
 * belongs to the USER, and every key that user holds draws from it.
 *
 * The behaviour these tests defend, in plain terms:
 *
 *   admin grants Alice 1000 积分
 *     → Alice mints 3 keys
 *     → calls on any of those 3 keys decrement the SAME 1000
 *     → when the 1000 runs out, all 3 keys stop working
 *
 * The alternative model — a quota per key — silently multiplies whatever the
 * admin granted by the number of keys a user mints, which is not what
 * "give Alice 1000 credits" means to anyone operating this thing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser, getUserById, updateUser, incrementUserQuotaUsed } from "@/lib/db/users";
import { createApiKey, listApiKeysByUser } from "@/lib/db/keys";
import { checkKeyStatus } from "@/lib/auth/apikey";
import { DEFAULT_USER_ALLOCATION, UserSchema } from "@/lib/db/types";

const NOW = new Date("2026-09-21T10:00:00Z").getTime();

describe("credit pool defaults", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("DEFAULT_USER_ALLOCATION grants nothing and caps nothing", () => {
    // A brand-new account has no credits until an admin allocates some —
    // this is deliberate, so a half-configured account can't burn upstream
    // spend.
    expect(DEFAULT_USER_ALLOCATION.quotaType).toBe("credits");
    expect(DEFAULT_USER_ALLOCATION.quotaLimit).toBe(0);
    expect(DEFAULT_USER_ALLOCATION.maxActiveKeys).toBe(0);
    expect(DEFAULT_USER_ALLOCATION.allowedModels).toEqual([]);
  });

  it("createUser starts the account with an empty, unspent pool", async () => {
    const u = await createUser({ username: "alice", password: "longenoughpw" });
    expect(u.quotaType).toBe("credits");
    expect(u.quotaLimit).toBe(0);
    expect(u.quotaUsed).toBe(0);
  });

  it("UserSchema fills pool fields when a legacy record omits them", () => {
    const parsed = UserSchema.parse({
      id: "01J",
      username: "legacy",
      passwordHash: "$2a$12$xxx",
      role: "user",
      displayName: "Legacy",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastLoginAt: null,
      disabled: false,
    });
    expect(parsed.quotaType).toBe("credits");
    expect(parsed.quotaLimit).toBe(0);
    expect(parsed.quotaUsed).toBe(0);
  });
});

describe("granting credits", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("admin grants a pool at creation time", async () => {
    const u = await createUser({
      username: "bob",
      password: "longenoughpw",
      quotaType: "credits",
      quotaLimit: 5_000_000, // 5,000 积分
      allowedModels: ["gpt-4o-mini"],
      maxActiveKeys: 3,
    });
    expect(u.quotaLimit).toBe(5_000_000);
    expect(u.allowedModels).toEqual(["gpt-4o-mini"]);
    expect(u.maxActiveKeys).toBe(3);
  });

  it("admin can top up an existing account", async () => {
    const u = await createUser({ username: "carol", password: "longenoughpw" });
    const updated = await updateUser(u.id, { quotaLimit: 2_000_000 });
    expect(updated!.quotaLimit).toBe(2_000_000);
    expect(updated!.quotaUsed).toBe(0);
  });

  it("admin can reset consumption without touching the grant", async () => {
    const u = await createUser({
      username: "dave",
      password: "longenoughpw",
      quotaLimit: 1000,
    });
    await incrementUserQuotaUsed(u.id, 400);
    expect((await getUserById(u.id))!.quotaUsed).toBe(400);

    const reset = await updateUser(u.id, { quotaUsed: 0 });
    expect(reset!.quotaUsed).toBe(0);
    expect(reset!.quotaLimit).toBe(1000);
  });

  it("persists the pool through Redis", async () => {
    const u = await createUser({
      username: "erin",
      password: "longenoughpw",
      quotaType: "tokens",
      quotaLimit: 12345,
      maxActiveKeys: 7,
      allowedModels: ["gpt-4o"],
    });
    const fetched = await getUserById(u.id);
    expect(fetched!.quotaType).toBe("tokens");
    expect(fetched!.quotaLimit).toBe(12345);
    expect(fetched!.maxActiveKeys).toBe(7);
    expect(fetched!.allowedModels).toEqual(["gpt-4o"]);
  });
});

describe("multiple keys share one pool", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("a key carries no balance of its own", async () => {
    const u = await createUser({ username: "frank", password: "longenoughpw", quotaLimit: 1000 });
    const { key } = await createApiKey({ userId: u.id, label: "k" });
    expect("quotaLimit" in key).toBe(false);
    expect("quotaUsed" in key).toBe(false);
  });

  it("three keys draw down the same 1000 积分", async () => {
    const u = await createUser({
      username: "gina",
      password: "longenoughpw",
      quotaLimit: 1000,
    });
    await createApiKey({ userId: u.id, label: "a" });
    await createApiKey({ userId: u.id, label: "b" });
    await createApiKey({ userId: u.id, label: "c" });

    const { keys } = await listApiKeysByUser(u.id, { limit: 10 });
    expect(keys).toHaveLength(3);

    // Charge 400 through three separate "requests".
    await incrementUserQuotaUsed(u.id, 100);
    await incrementUserQuotaUsed(u.id, 150);
    await incrementUserQuotaUsed(u.id, 150);

    const owner = await getUserById(u.id);
    // 400 total — not 400 per key (which would be 1200 and invisible).
    expect(owner!.quotaUsed).toBe(400);
  });

  it("exhausting the pool blocks EVERY key the user holds", async () => {
    const u = await createUser({
      username: "harry",
      password: "longenoughpw",
      quotaLimit: 1000,
    });
    const { key: keyA } = await createApiKey({ userId: u.id, label: "a" });
    const { key: keyB } = await createApiKey({ userId: u.id, label: "b" });

    await incrementUserQuotaUsed(u.id, 1000);
    const owner = (await getUserById(u.id))!;

    const a = checkKeyStatus({ key: keyA, user: owner, now: NOW });
    const b = checkKeyStatus({ key: keyB, user: owner, now: NOW });
    expect(a.reason).toBe("quota_exceeded_credits");
    expect(b.reason).toBe("quota_exceeded_credits");
  });

  it("disabling one key leaves the others working", async () => {
    const u = await createUser({
      username: "ivy",
      password: "longenoughpw",
      quotaLimit: 1000,
    });
    const { key: disabled } = await createApiKey({ userId: u.id, label: "off" });
    const { key: active } = await createApiKey({ userId: u.id, label: "on" });
    const owner = (await getUserById(u.id))!;

    const off = checkKeyStatus({
      key: { ...disabled, enabled: false },
      user: owner,
      now: NOW,
    });
    const on = checkKeyStatus({ key: active, user: owner, now: NOW });

    expect(off.reason).toBe("key_disabled");
    expect(on.ok).toBe(true);
  });
});

describe("model access is owned by the account", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("a key cannot reach a model the account lacks", async () => {
    const u = await createUser({
      username: "jane",
      password: "longenoughpw",
      quotaLimit: 1000,
      allowedModels: ["gpt-4o-mini"],
    });
    const { key } = await createApiKey({
      userId: u.id,
      label: "wide",
      // The key asks for more than the account holds.
      allowedModels: ["gpt-4o-mini", "claude-3-5-sonnet"],
    });
    const owner = (await getUserById(u.id))!;

    const r = checkKeyStatus({
      key,
      user: owner,
      requestedModel: "claude-3-5-sonnet",
      now: NOW,
    });
    expect(r.reason).toBe("model_not_allowed");
  });

  it("an account-wide whitelist still allows every model when empty", async () => {
    const u = await createUser({
      username: "kate",
      password: "longenoughpw",
      quotaLimit: 1000,
      allowedModels: [],
    });
    const { key } = await createApiKey({ userId: u.id, label: "any" });
    const owner = (await getUserById(u.id))!;

    const r = checkKeyStatus({
      key,
      user: owner,
      requestedModel: "whatever-model",
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});
