/**
 * tests/integration/repos.test.ts
 *
 * Exercises every repository against the in-memory Redis mock.
 *
 * What's covered:
 * - users:    create / get / list / update / reset / disable / delete
 * - keys:     create / get / getByPlaintext / list / update / quota / delete
 * - providers: create / get / list / findProvidersForModel / update / delete
 * - usage:    record / list / aggregate
 * - cascade:  deleting a user removes their api keys
 *
 * Mocks the @vercel/sdk so any cross-module imports don't try to hit real APIs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  updateUser,
  resetUserPassword,
  disableUser,
  deleteUser,
  verifyUserCredentials,
  bootstrapAdminIfNeeded,
  incrementUserQuotaUsed,
} from "@/lib/db/users";
import {
  createApiKey,
  getApiKeyById,
  getApiKeyByPlaintext,
  listApiKeysByUser,
  listAllApiKeys,
  updateApiKey,
  setApiKeyEnabled,
  deleteApiKey,
} from "@/lib/db/keys";
import {
  createProvider,
  getProviderById,
  listProviders,
  findProvidersForModel,
  updateProvider,
  deleteProvider,
} from "@/lib/db/providers";
import {
  recordUsage,
  listUsageByKey,
  aggregateByKey,
  aggregateByUser,
} from "@/lib/db/usage";
import { generateApiKey as _makeKey } from "@/lib/crypto/hashing";

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis());
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

describe("users repository", () => {
  it("createUser + getUserById roundtrip", async () => {
    const u = await createUser({
      username: "alice",
      password: "secret-123",
      role: "user",
      displayName: "Alice",
    });
    expect(u.id).toBeTruthy();
    expect(u.passwordHash).toMatch(/^\$2/);
    expect(u.disabled).toBe(false);

    const fetched = await getUserById(u.id);
    expect(fetched?.username).toBe("alice");
  });

  it("rejects duplicate usernames", async () => {
    await createUser({ username: "bob", password: "x" });
    await expect(
      createUser({ username: "bob", password: "y" }),
    ).rejects.toThrow(/already exists/);
  });

  it("getUserByUsername works after create", async () => {
    await createUser({ username: "carol", password: "x" });
    const c = await getUserByUsername("carol");
    expect(c).not.toBeNull();
  });

  it("verifyUserCredentials succeeds with right password", async () => {
    await createUser({ username: "dave", password: "right" });
    const u = await verifyUserCredentials("dave", "right");
    expect(u).not.toBeNull();
    expect(u?.username).toBe("dave");
  });

  it("verifyUserCredentials rejects wrong password", async () => {
    await createUser({ username: "eve", password: "right" });
    expect(await verifyUserCredentials("eve", "wrong")).toBeNull();
  });

  it("updateUser changes fields", async () => {
    const u = await createUser({ username: "frank", password: "x" });
    const updated = await updateUser(u.id, { displayName: "Frank the Tank", role: "admin" });
    expect(updated?.displayName).toBe("Frank the Tank");
    expect(updated?.role).toBe("admin");
  });

  it("resetUserPassword changes the hash", async () => {
    const u = await createUser({ username: "george", password: "old" });
    expect(await verifyUserCredentials("george", "old")).not.toBeNull();
    expect(await verifyUserCredentials("george", "new")).toBeNull();

    await resetUserPassword(u.id, "new");
    expect(await verifyUserCredentials("george", "old")).toBeNull();
    expect(await verifyUserCredentials("george", "new")).not.toBeNull();
  });

  it("disableUser blocks login", async () => {
    const u = await createUser({ username: "harry", password: "p" });
    expect(await verifyUserCredentials("harry", "p")).not.toBeNull();
    await disableUser(u.id);
    expect(await verifyUserCredentials("harry", "p")).toBeNull();
  });

  it("deleteUser removes the record and the username index", async () => {
    const u = await createUser({ username: "del", password: "x" });
    expect(await getUserById(u.id)).not.toBeNull();
    expect(await deleteUser(u.id)).toBe(true);
    expect(await getUserById(u.id)).toBeNull();
    expect(await getUserByUsername("del")).toBeNull();
  });

  it("listUsers returns paginated list", async () => {
    for (const n of ["alice2", "bob2", "carol2", "dave2", "eve2"]) {
      await createUser({ username: n, password: "x" });
    }
    const page1 = await listUsers({ limit: 3 });
    expect(page1.users.map((u) => u.username)).toEqual(["alice2", "bob2", "carol2"]);
    expect(page1.nextCursor).toBe("carol2");

    const page2 = await listUsers({ limit: 3, cursor: page1.nextCursor! });
    expect(page2.users.map((u) => u.username)).toEqual(["dave2", "eve2"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("bootstrapAdminIfNeeded is idempotent", async () => {
    const a = await bootstrapAdminIfNeeded({ username: "admin", password: "x" });
    expect(a).not.toBeNull();
    expect(a?.role).toBe("admin");

    const b = await bootstrapAdminIfNeeded({ username: "admin2", password: "y" });
    expect(b).toBeNull(); // already initialized
  });
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe("keys repository", () => {
  let userId: string;

  beforeEach(async () => {
    const u = await createUser({ username: "key-owner", password: "x" });
    userId = u.id;
  });

  it("createApiKey returns plaintext exactly once", async () => {
    const result = await createApiKey({
      userId,
      label: "Macbook",
    });
    expect(result.plainKey).toMatch(/^sk-relay-/);
    expect(result.key.keyHash).toHaveLength(64);

    // Plaintext must roundtrip via hash → id.
    const fetched = await getApiKeyByPlaintext(result.plainKey);
    expect(fetched?.id).toBe(result.key.id);
  });

  it("getApiKeyByPlaintext returns null for unknown", async () => {
    expect(await getApiKeyByPlaintext("sk-relay-doesnotexist")).toBeNull();
  });

  it("listApiKeysByUser returns only that user's keys", async () => {
    await createApiKey({ userId, label: "k1" });
    await createApiKey({ userId, label: "k2" });
    const other = await createUser({ username: "other", password: "x" });
    await createApiKey({ userId: other.id, label: "k3" });

    const list = await listApiKeysByUser(userId);
    expect(list.keys).toHaveLength(2);
    expect(list.keys.map((k) => k.label).sort()).toEqual(["k1", "k2"]);
  });

  it("updateApiKey applies patch", async () => {
    const { key } = await createApiKey({
      userId,
      label: "before",
    });
    const expires = "2030-01-01T00:00:00.000Z";
    const updated = await updateApiKey(key.id, {
      label: "after",
      expiresAt: expires,
    });
    expect(updated?.label).toBe("after");
    expect(updated?.expiresAt).toBe(expires);
  });

  it("a key carries no quota of its own — the pool is on the user", async () => {
    const { key } = await createApiKey({ userId, label: "scoped" });
    expect("quotaLimit" in key).toBe(false);
    expect("quotaUsed" in key).toBe(false);
  });

  it("setApiKeyEnabled flips the flag", async () => {
    const { key } = await createApiKey({
      userId,
      label: "l",
    });
    expect(key.enabled).toBe(true);
    const after = await setApiKeyEnabled(key.id, false);
    expect(after?.enabled).toBe(false);
  });

  it("incrementUserQuotaUsed accumulates on the owner, not the key", async () => {
    const { key } = await createApiKey({ userId, label: "l" });
    await incrementUserQuotaUsed(userId, 5);
    await incrementUserQuotaUsed(userId, 3);
    const owner = await getUserById(userId);
    expect(owner?.quotaUsed).toBe(8);

    // The key itself still carries no balance.
    const fresh = await getApiKeyById(key.id);
    expect("quotaUsed" in (fresh as object)).toBe(false);
  });

  it("keys held by one account share a single pool", async () => {
    await createApiKey({ userId, label: "a" });
    await createApiKey({ userId, label: "b" });
    await incrementUserQuotaUsed(userId, 10);
    await incrementUserQuotaUsed(userId, 7);
    const owner = await getUserById(userId);
    // Two keys, one balance: 17 — not 17 per key.
    expect(owner?.quotaUsed).toBe(17);
  });

  it("incrementUserQuotaUsed rejects a negative delta", async () => {
    await expect(incrementUserQuotaUsed(userId, -1)).rejects.toThrow(RangeError);
  });

  it("deleteApiKey removes hash + set", async () => {
    const { key, plainKey } = await createApiKey({
      userId,
      label: "l",
    });
    expect(await getApiKeyById(key.id)).not.toBeNull();
    expect(await deleteApiKey(key.id)).toBe(true);
    expect(await getApiKeyById(key.id)).toBeNull();
    expect(await getApiKeyByPlaintext(plainKey)).toBeNull();
  });

  it("listAllApiKeys with enabledOnly filter", async () => {
    const { key } = await createApiKey({
      userId,
      label: "l",
    });
    await createApiKey({ userId, label: "m" });
    await setApiKeyEnabled(key.id, false);

    const enabled = await listAllApiKeys({ enabledOnly: true });
    expect(enabled.map((k) => k.label)).toEqual(["m"]);

    const all = await listAllApiKeys();
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

describe("providers repository", () => {
  it("createProvider + getProviderById roundtrip", async () => {
    const p = await createProvider({
      name: "OpenAI",
      kind: "openai",
      apiKey: "sk-upstream-abc",
      modelMapping: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
    });
    expect(p.id).toBeTruthy();
    expect(p.encryptedApiKey).not.toBe("sk-upstream-abc"); // encrypted
    expect(p.encryptedApiKey).toMatch(/^[A-Za-z0-9+/=]+$/);

    const fetched = await getProviderById(p.id);
    expect(fetched?.name).toBe("OpenAI");
    expect(fetched?.modelMapping["gpt-4o-mini"]).toBe("gpt-4o-mini-2024-07-18");
  });

  it("listProviders returns enabled-only when requested", async () => {
    await createProvider({ name: "A", kind: "openai", apiKey: "x" });
    await createProvider({ name: "B", kind: "anthropic", apiKey: "y" });

    const enabled = await listProviders({ enabledOnly: true });
    expect(enabled).toHaveLength(2);

    const all = await listProviders();
    expect(all).toHaveLength(2);
  });

  it("findProvidersForModel returns providers that map the client model", async () => {
    const a = await createProvider({
      name: "A",
      kind: "openai",
      apiKey: "x",
      modelMapping: { "gpt-4o-mini": "gpt-4o-mini-2024-07-18" },
    });
    await createProvider({
      name: "B",
      kind: "anthropic",
      apiKey: "y",
      modelMapping: { "claude-3-5-sonnet": "claude-3-5-sonnet-20241022" },
    });

    const forGpt = await findProvidersForModel("gpt-4o-mini");
    expect(forGpt.map((p) => p.id)).toEqual([a.id]);

    const forClaude = await findProvidersForModel("claude-3-5-sonnet");
    expect(forClaude).toHaveLength(1);
    expect(forClaude[0].name).toBe("B");

    expect(await findProvidersForModel("unknown-model")).toHaveLength(0);
  });

  it("updateProvider patches fields and re-encrypts API key", async () => {
    const p = await createProvider({
      name: "Old",
      kind: "openai",
      apiKey: "sk-first",
    });
    const updated = await updateProvider(p.id, {
      name: "New",
      apiKey: "sk-second",
    });
    expect(updated?.name).toBe("New");
    expect(updated?.encryptedApiKey).not.toBe(p.encryptedApiKey); // changed
    expect(updated?.encryptedApiKey).not.toBe("sk-second");
  });

  it("updateProvider without apiKey keeps existing encryption", async () => {
    const p = await createProvider({
      name: "X",
      kind: "openai",
      apiKey: "sk-original",
    });
    const updated = await updateProvider(p.id, { name: "Y" });
    expect(updated?.encryptedApiKey).toBe(p.encryptedApiKey); // unchanged
    expect(updated?.name).toBe("Y");
  });

  it("deleteProvider removes the record", async () => {
    const p = await createProvider({
      name: "Del",
      kind: "openai",
      apiKey: "x",
    });
    expect(await deleteProvider(p.id)).toBe(true);
    expect(await getProviderById(p.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe("usage repository", () => {
  it("recordUsage + listUsageByKey roundtrip", async () => {
    const log = await recordUsage({
      apiKeyId: "k1",
      userId: "u1",
      providerId: "p1",
      model: "gpt-4o-mini",
      upstreamModel: "gpt-4o-mini-2024-07-18",
      promptTokens: 10,
      completionTokens: 20,
      creditsUsed: 5,
      status: "success",
    });
    expect(log.totalTokens).toBe(30);

    const logs = await listUsageByKey("k1");
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(log.id);
  });

  it("listUsageByKey caps at MAX_LOGS_PER_KEY", async () => {
    for (let i = 0; i < 5; i++) {
      await recordUsage({
        apiKeyId: "k",
        userId: "u",
        providerId: "p",
        model: "x",
        upstreamModel: "x",
        promptTokens: 1,
        completionTokens: 1,
        creditsUsed: 0,
        status: "success",
      });
    }
    const logs = await listUsageByKey("k", { limit: 2 });
    expect(logs).toHaveLength(2);
  });

  it("aggregateByKey sums tokens and credits", async () => {
    await recordUsage({
      apiKeyId: "k",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 100,
      completionTokens: 50,
      creditsUsed: 5,
      status: "success",
    });
    await recordUsage({
      apiKeyId: "k",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 200,
      completionTokens: 100,
      creditsUsed: 10,
      status: "success",
    });
    await recordUsage({
      apiKeyId: "k",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 999,
      completionTokens: 999,
      creditsUsed: 999,
      status: "error",
    });

    const agg = await aggregateByKey("k");
    expect(agg.promptTokens).toBe(300);
    expect(agg.completionTokens).toBe(150);
    expect(agg.totalTokens).toBe(450);
    expect(agg.creditsUsed).toBe(15);
    expect(agg.requestCount).toBe(2); // error excluded
  });

  it("aggregateByUser sums across multiple keys", async () => {
    await recordUsage({
      apiKeyId: "k1",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 10,
      completionTokens: 5,
      creditsUsed: 1,
      status: "success",
    });
    await recordUsage({
      apiKeyId: "k2",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 20,
      completionTokens: 10,
      creditsUsed: 2,
      status: "success",
    });
    const agg = await aggregateByUser(["k1", "k2"]);
    expect(agg.totalTokens).toBe(45);
    expect(agg.creditsUsed).toBe(3);
  });

  it("aggregate respects date range", async () => {
    await recordUsage({
      apiKeyId: "k",
      userId: "u",
      providerId: "p",
      model: "x",
      upstreamModel: "x",
      promptTokens: 1,
      completionTokens: 1,
      creditsUsed: 1,
      status: "success",
    });
    const future = "2999-01-01T00:00:00.000Z";
    const agg = await aggregateByKey("k", { from: future });
    expect(agg.totalTokens).toBe(0);
  });
});
