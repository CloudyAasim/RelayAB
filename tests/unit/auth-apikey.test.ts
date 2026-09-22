/**
 * tests/unit/auth-apikey.test.ts
 *
 * Validates customer API key authentication:
 * - parseBearer handles all common Authorization header shapes
 * - checkKeyStatus correctly handles every failure reason
 * - authenticateBearer end-to-end with the in-memory Redis mock
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseBearer,
  checkKeyStatus,
  authenticateBearer,
  reasonToHttp,
} from "@/lib/auth/apikey";
import { getRedis, k, __resetRedisForTest } from "@/lib/db/redis";
import { generateApiKey, sha256Hex } from "@/lib/crypto/hashing";
import type { ApiKey, User } from "@/lib/db/types";

const NOW = new Date("2026-09-21T10:00:00Z").getTime();

function makeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  const plain = generateApiKey();
  return {
    id: "01JK0001",
    userId: "01JU0001",
    label: "test",
    keyHash: sha256Hex(plain),
    keyPrefix: plain.slice(0, 12) + "..." + plain.slice(-4),
    expiresAt: null,
    enabled: true,
    forceDisabled: false,
    allowedModels: [],
    createdAt: "2026-09-01T00:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

/**
 * Owner of the key above. The quota pool and the model whitelist live here,
 * which is the whole point of the user-centric model under test.
 */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "01JU0001",
    username: "owner",
    passwordHash: "$2a$12$notarealhash",
    role: "user",
    displayName: "Owner",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    lastLoginAt: null,
    disabled: false,
    quotaType: "credits",
    quotaLimit: 1000,
    quotaUsed: 0,
    maxActiveKeys: 0,
    allowedModels: [],
    ...overrides,
  };
}

async function seedKey(key: ApiKey, user: User = makeUser()): Promise<string> {
  const redis = getRedis();
  await redis.hset(k.apiKey(key.id), {
    id: key.id,
    userId: key.userId,
    label: key.label,
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
    expiresAt: key.expiresAt ?? "",
    enabled: key.enabled ? "1" : "0",
    allowedModels: key.allowedModels.join(","),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt ?? "",
  });
  await redis.set(k.apiKeyByHash(key.keyHash), key.id);
  await seedUser(user);
  return key.id;
}

async function seedUser(user: User): Promise<void> {
  const redis = getRedis();
  await redis.hset(k.user(user.id), {
    id: user.id,
    username: user.username,
    passwordHash: user.passwordHash,
    role: user.role,
    displayName: user.displayName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? "",
    disabled: user.disabled ? "1" : "0",
    quotaType: user.quotaType,
    quotaLimit: String(user.quotaLimit),
    quotaUsed: String(user.quotaUsed),
    maxActiveKeys: String(user.maxActiveKeys),
    allowedModels: user.allowedModels.join(","),
  });
  await redis.set(k.userByUsername(user.username), user.id);
}

describe("parseBearer", () => {
  it("accepts well-formed header", () => {
    expect(parseBearer("Bearer sk-relay-abc")).toBe("sk-relay-abc");
  });
  it("is case-insensitive on scheme", () => {
    expect(parseBearer("bearer sk-relay-abc")).toBe("sk-relay-abc");
    expect(parseBearer("BEARER sk-relay-abc")).toBe("sk-relay-abc");
  });
  it("trims whitespace", () => {
    expect(parseBearer("  Bearer   sk-relay-abc  ")).toBe("sk-relay-abc");
  });
  it("rejects Basic auth", () => {
    expect(parseBearer("Basic dXNlcjpwYXNz")).toBeNull();
  });
  it("rejects empty / missing", () => {
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
  it("rejects scheme-only", () => {
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
  });
  it("rejects non-string", () => {
    // @ts-expect-error runtime check
    expect(parseBearer(123)).toBeNull();
  });
});

describe("checkKeyStatus", () => {
  it("returns ok for a fresh key", () => {
    const r = checkKeyStatus({ key: makeKey(), now: NOW });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("returns key_disabled when disabled", () => {
    const r = checkKeyStatus({
      key: makeKey({ enabled: false }),
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("key_disabled");
  });

  it("returns key_force_disabled when an admin force-disabled the key", () => {
    // The admin override must win even if `enabled` is still true: the toggle
    // endpoint accepts `{ forceDisabled: true }` on its own, and relying on the
    // UI to also flip `enabled` made that combination a silent no-op.
    const key = makeKey({ enabled: true, forceDisabled: true });
    const result = checkKeyStatus({ key, user: makeUser() });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("key_force_disabled");
  });

  it("returns key_expired when expiresAt is in the past", () => {
    const r = checkKeyStatus({
      key: makeKey({ expiresAt: "2020-01-01T00:00:00Z" }),
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("key_expired");
  });

  it("does not flag an unexpired key", () => {
    const r = checkKeyStatus({
      key: makeKey({ expiresAt: "2030-01-01T00:00:00Z" }),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("returns quota_exceeded_credits when the OWNER's pool is spent", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ quotaType: "credits", quotaLimit: 100, quotaUsed: 100 }),
      now: NOW,
    });
    expect(r.reason).toBe("quota_exceeded_credits");
  });

  it("returns quota_exceeded_tokens when the OWNER's token pool is spent", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ quotaType: "tokens", quotaLimit: 50_000, quotaUsed: 50_000 }),
      now: NOW,
    });
    expect(r.reason).toBe("quota_exceeded_tokens");
  });

  it("does not flag an owner who still has headroom", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ quotaLimit: 100, quotaUsed: 99 }),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("treats an unallocated pool (limit 0) as exhausted", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ quotaLimit: 0, quotaUsed: 0 }),
      now: NOW,
    });
    // "0 credits granted" blocks calls rather than meaning "unlimited".
    expect(r.reason).toBe("quota_exceeded_credits");
  });

  it("blocks a disabled owner", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ disabled: true }),
      now: NOW,
    });
    expect(r.reason).toBe("user_disabled");
  });

  it("minting extra keys does not mint extra budget", () => {
    // Two different keys, same owner, same exhausted pool → both refused.
    const owner = makeUser({ quotaLimit: 100, quotaUsed: 100 });
    const a = checkKeyStatus({ key: makeKey(), user: owner, now: NOW });
    const b = checkKeyStatus({
      key: makeKey({ id: "01JK0002" }),
      user: owner,
      now: NOW,
    });
    expect(a.reason).toBe("quota_exceeded_credits");
    expect(b.reason).toBe("quota_exceeded_credits");
  });

  it("the owner whitelist is the outer bound on models", () => {
    const r = checkKeyStatus({
      key: makeKey(),
      user: makeUser({ allowedModels: ["gpt-4o-mini"] }),
      requestedModel: "claude-3-5-sonnet",
      now: NOW,
    });
    expect(r.reason).toBe("model_not_allowed");
  });

  it("a key can narrow but never widen the owner's whitelist", () => {
    const owner = makeUser({ allowedModels: ["gpt-4o-mini"] });
    // Key asks for something the owner cannot reach → still refused.
    const widened = checkKeyStatus({
      key: makeKey({ allowedModels: ["claude-3-5-sonnet"] }),
      user: owner,
      requestedModel: "claude-3-5-sonnet",
      now: NOW,
    });
    expect(widened.reason).toBe("model_not_allowed");

    // Key narrows to a model the owner holds → allowed.
    const narrowed = checkKeyStatus({
      key: makeKey({ allowedModels: ["gpt-4o-mini"] }),
      user: owner,
      requestedModel: "gpt-4o-mini",
      now: NOW,
    });
    expect(narrowed.ok).toBe(true);
  });

  it("returns model_not_allowed when requested model not in whitelist", () => {
    const r = checkKeyStatus({
      key: makeKey({ allowedModels: ["gpt-4o-mini"] }),
      requestedModel: "claude-3-5-sonnet",
      now: NOW,
    });
    expect(r.reason).toBe("model_not_allowed");
  });

  it("allows whitelisted model", () => {
    const r = checkKeyStatus({
      key: makeKey({ allowedModels: ["gpt-4o-mini"] }),
      requestedModel: "gpt-4o-mini",
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("ignores allowedModels when list is empty (all models allowed)", () => {
    const r = checkKeyStatus({
      key: makeKey({ allowedModels: [] }),
      requestedModel: "any-model",
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("does not check models when requestedModel is not provided", () => {
    const r = checkKeyStatus({
      key: makeKey({ allowedModels: ["only-this"] }),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});

describe("reasonToHttp", () => {
  it("maps each reason correctly", () => {
    expect(reasonToHttp("missing_key")).toEqual({
      status: 401, code: "unauthorized", message: expect.any(String),
    });
    expect(reasonToHttp("key_not_found").status).toBe(401);
    expect(reasonToHttp("key_disabled").status).toBe(403);
    expect(reasonToHttp("key_force_disabled").status).toBe(403);
    expect(reasonToHttp("key_force_disabled").code).toBe("key_force_disabled");
    expect(reasonToHttp("key_expired").status).toBe(403);
    expect(reasonToHttp("quota_exceeded_credits").status).toBe(403);
    expect(reasonToHttp("quota_exceeded_tokens").status).toBe(403);
    expect(reasonToHttp("model_not_allowed").status).toBe(403);
    expect(reasonToHttp("unknown").status).toBe(500);
  });
});

describe("authenticateBearer (end-to-end with in-memory Redis)", () => {
  beforeEach(() => {
    __resetRedisForTest();
  });

  it("returns missing_key when header is absent", async () => {
    const r = await authenticateBearer({ authHeader: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_key");
  });

  it("returns key_not_found for unknown key", async () => {
    const r = await authenticateBearer({
      authHeader: "Bearer sk-relay-unknownkey",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("key_not_found");
  });

  it("returns ok for a valid key", async () => {
    const plain = generateApiKey();
    const key = makeKey({ keyHash: sha256Hex(plain) });
    await seedKey(key);

    const r = await authenticateBearer({ authHeader: `Bearer ${plain}` });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("ok");
    expect(r.key?.id).toBe(key.id);
  });

  it("enforces model whitelist end-to-end", async () => {
    const plain = generateApiKey();
    const key = makeKey({
      keyHash: sha256Hex(plain),
      allowedModels: ["gpt-4o-mini"],
    });
    await seedKey(key);

    const r = await authenticateBearer({
      authHeader: `Bearer ${plain}`,
      requestedModel: "claude-3-5-sonnet",
    });
    expect(r.reason).toBe("model_not_allowed");
  });

  it("enforces disabled key end-to-end", async () => {
    const plain = generateApiKey();
    const key = makeKey({ keyHash: sha256Hex(plain), enabled: false });
    await seedKey(key);

    const r = await authenticateBearer({ authHeader: `Bearer ${plain}` });
    expect(r.reason).toBe("key_disabled");
  });

  it("enforces the owner's exhausted quota end-to-end", async () => {
    const plain = generateApiKey();
    const key = makeKey({ keyHash: sha256Hex(plain) });
    await seedKey(key, makeUser({ quotaLimit: 100, quotaUsed: 100 }));

    const r = await authenticateBearer({ authHeader: `Bearer ${plain}` });
    expect(r.reason).toBe("quota_exceeded_credits");
  });

  it("enforces a disabled owner end-to-end", async () => {
    const plain = generateApiKey();
    const key = makeKey({ keyHash: sha256Hex(plain) });
    await seedKey(key, makeUser({ disabled: true }));

    const r = await authenticateBearer({ authHeader: `Bearer ${plain}` });
    expect(r.reason).toBe("user_disabled");
  });
});
