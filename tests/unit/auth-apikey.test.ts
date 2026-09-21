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
    quotaType: "credits",
    quotaLimit: 1000,
    quotaUsed: 0,
    expiresAt: null,
    enabled: true,
    allowedModels: [],
    createdAt: "2026-09-01T00:00:00Z",
    lastUsedAt: null,
    ...overrides,
  };
}

async function seedKey(key: ApiKey): Promise<string> {
  const redis = getRedis();
  await redis.hset(k.apiKey(key.id), {
    id: key.id,
    userId: key.userId,
    label: key.label,
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
    quotaType: key.quotaType,
    quotaLimit: String(key.quotaLimit),
    quotaUsed: String(key.quotaUsed),
    expiresAt: key.expiresAt ?? "",
    enabled: key.enabled ? "1" : "0",
    allowedModels: key.allowedModels.join(","),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt ?? "",
  });
  await redis.set(k.apiKeyByHash(key.keyHash), key.id);
  // We don't know the plaintext here in tests; reconstruct from hash via
  // a side map. For tests we use a helper plaintext.
  return key.id;
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

  it("returns quota_exceeded_credits when used >= limit", () => {
    const r = checkKeyStatus({
      key: makeKey({ quotaType: "credits", quotaLimit: 100, quotaUsed: 100 }),
      now: NOW,
    });
    expect(r.reason).toBe("quota_exceeded_credits");
  });

  it("returns quota_exceeded_tokens when used >= limit", () => {
    const r = checkKeyStatus({
      key: makeKey({ quotaType: "tokens", quotaLimit: 50_000, quotaUsed: 50_000 }),
      now: NOW,
    });
    expect(r.reason).toBe("quota_exceeded_tokens");
  });

  it("does not flag under-limit quota", () => {
    const r = checkKeyStatus({
      key: makeKey({ quotaType: "credits", quotaLimit: 100, quotaUsed: 99 }),
      now: NOW,
    });
    expect(r.ok).toBe(true);
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

  it("enforces quota end-to-end", async () => {
    const plain = generateApiKey();
    const key = makeKey({
      keyHash: sha256Hex(plain),
      quotaType: "credits",
      quotaLimit: 100,
      quotaUsed: 100,
    });
    await seedKey(key);

    const r = await authenticateBearer({ authHeader: `Bearer ${plain}` });
    expect(r.reason).toBe("quota_exceeded_credits");
  });
});
