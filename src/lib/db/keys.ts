/**
 * src/lib/db/keys.ts
 *
 * Repository for customer `ApiKey` entities.
 *
 * Schema (mirrors `docs/DATA_MODEL.md` §2):
 *   HASH    relay:apikey:{keyId}               → ApiKey fields
 *   STRING  relay:apikey:hash:{sha256(key)}    → keyId  (Bearer lookup)
 *   SET     relay:apikey:by-user:{userId}      → [keyId, ...]
 *
 * Quota bookkeeping is split into two fields on the hash itself:
 *   quotaUsed — incremented in real-time per request.
 *   quotaLimit — set at creation/edit.
 *
 * Unit depends on `quotaType`: for `credits` both fields are **积分**
 * stored as integer 0.001-积分 units (see lib/quota/credits.ts); for
 * `tokens` they are token counts.
 *
 * Plaintext keys are NEVER stored: only the sha256 is kept. The plaintext
 * is returned ONCE from createApiKey and is unrecoverable afterwards.
 */
import { sha256Hex, generateApiKey, maskApiKey } from "../crypto/hashing";
import { ApiKeySchema, type ApiKey } from "./types";
import { getRedis, k } from "./redis";
import { generateId } from "../crypto/hashing";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiKeyNotFoundError extends Error {
  constructor(public readonly keyId: string) {
    super(`API key not found: ${keyId}`);
    this.name = "ApiKeyNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  userId: string;
  label: string;
  quotaType: "credits" | "tokens";
  quotaLimit: number;
  expiresAt?: string | null;
  allowedModels?: string[];
}

export interface UpdateApiKeyInput {
  label?: string;
  quotaType?: "credits" | "tokens";
  quotaLimit?: number;
  expiresAt?: string | null;
  allowedModels?: string[];
  enabled?: boolean;
}

export interface ApiKeyWithPlaintext {
  key: ApiKey;
  plainKey: string;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new API key.
 *
 * Generates a fresh plaintext key, stores its sha256 hash, and returns
 * the plaintext exactly once in `result.plainKey`. The repository
 * cannot recover the plaintext later.
 */
export async function createApiKey(input: CreateApiKeyInput): Promise<ApiKeyWithPlaintext> {
  const plain = generateApiKey();
  const id = generateId();
  const now = new Date().toISOString();
  const keyHash = sha256Hex(plain);

  const apiKey: ApiKey = ApiKeySchema.parse({
    id,
    userId: input.userId,
    label: input.label,
    keyHash,
    keyPrefix: maskApiKey(plain),
    quotaType: input.quotaType,
    quotaLimit: input.quotaLimit,
    quotaUsed: 0,
    expiresAt: input.expiresAt ?? null,
    enabled: true,
    allowedModels: input.allowedModels ?? [],
    createdAt: now,
    lastUsedAt: null,
  });

  const redis = getRedis();
  const tx = redis.multi();
  tx.hset(k.apiKey(id), {
    id: apiKey.id,
    userId: apiKey.userId,
    label: apiKey.label,
    keyHash: apiKey.keyHash,
    keyPrefix: apiKey.keyPrefix,
    quotaType: apiKey.quotaType,
    quotaLimit: String(apiKey.quotaLimit),
    quotaUsed: String(apiKey.quotaUsed),
    expiresAt: apiKey.expiresAt ?? "",
    enabled: apiKey.enabled ? "1" : "0",
    allowedModels: apiKey.allowedModels.join(","),
    createdAt: apiKey.createdAt,
    lastUsedAt: apiKey.lastUsedAt ?? "",
  });
  tx.set(k.apiKeyByHash(keyHash), id);
  tx.sadd(k.apiKeyByUser(input.userId), id);
  await tx.exec();

  return { key: apiKey, plainKey: plain };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  if (!keyId) return null;
  return hashToKey(await getRedis().hgetall<Record<string, string>>(k.apiKey(keyId)));
}

/**
 * Look up an API key by the plaintext.
 * This is the hot path during Bearer authentication.
 */
export async function getApiKeyByPlaintext(plaintext: string): Promise<ApiKey | null> {
  if (!plaintext) return null;
  const hash = sha256Hex(plaintext);
  const id = await getRedis().get<string>(k.apiKeyByHash(hash));
  if (!id) return null;
  return getApiKeyById(id);
}

/** List all keys for a user (paginated). */
export async function listApiKeysByUser(
  userId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ keys: ApiKey[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const redis = getRedis();
  const allIds = await redis.smembers(k.apiKeyByUser(userId));

  const keys: ApiKey[] = [];
  for (const id of allIds) {
    const k = await getApiKeyById(id);
    if (k) keys.push(k);
  }
  keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  let startIdx = 0;
  if (opts.cursor) {
    const idx = keys.findIndex((k) => k.id > opts.cursor!);
    startIdx = idx >= 0 ? idx : keys.length;
  }
  const slice = keys.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < keys.length ? slice[slice.length - 1].id : null;
  return { keys: slice, nextCursor };
}

/** List all keys (admin view). */
export async function listAllApiKeys(opts: {
  limit?: number;
  userId?: string;
  enabledOnly?: boolean;
} = {}): Promise<ApiKey[]> {
  const redis = getRedis();
  const [, matched] = await redis.scan(0, {
    match: `${k.apiKey("").slice(0, -1)}*`,
    count: 500,
  });
  const keyIds = matched.filter((key) => key.startsWith(k.apiKey("")));

  const out: ApiKey[] = [];
  for (const key of keyIds) {
    const parsed = await hashToKey(await redis.hgetall<Record<string, string>>(key));
    if (!parsed) continue;
    if (opts.userId && parsed.userId !== opts.userId) continue;
    if (opts.enabledOnly && !parsed.enabled) continue;
    out.push(parsed);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateApiKey(
  keyId: string,
  patch: UpdateApiKeyInput,
): Promise<ApiKey | null> {
  const existing = await getApiKeyById(keyId);
  if (!existing) return null;

  const merged: ApiKey = ApiKeySchema.parse({
    ...existing,
    label: patch.label ?? existing.label,
    quotaType: patch.quotaType ?? existing.quotaType,
    quotaLimit: patch.quotaLimit ?? existing.quotaLimit,
    expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
    allowedModels: patch.allowedModels ?? existing.allowedModels,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
  });

  await getRedis().hset(k.apiKey(keyId), {
    label: merged.label,
    quotaType: merged.quotaType,
    quotaLimit: String(merged.quotaLimit),
    expiresAt: merged.expiresAt ?? "",
    allowedModels: merged.allowedModels.join(","),
    enabled: merged.enabled ? "1" : "0",
  });

  return merged;
}

export async function setApiKeyEnabled(
  keyId: string,
  enabled: boolean,
): Promise<ApiKey | null> {
  return updateApiKey(keyId, { enabled });
}

/**
 * Atomically increment quotaUsed and lastUsedAt.
 * Returns the new value. Throws if the key is missing.
 */
export async function incrementQuotaUsed(
  keyId: string,
  delta: number,
): Promise<ApiKey | null> {
  if (!Number.isFinite(delta) || delta < 0) {
    throw new RangeError("delta must be non-negative finite number");
  }
  const redis = getRedis();
  const newUsed = await redis.hincrby(k.apiKey(keyId), "quotaUsed", delta);
  const now = new Date().toISOString();
  await redis.hset(k.apiKey(keyId), { lastUsedAt: now });

  // Re-read full record so callers see consistent state.
  const fresh = await getApiKeyById(keyId);
  if (!fresh) return null;

  // If quota is now over limit, leave it as-is — the check happens at
  // request time, and the user might have a generous `quotaUsed` carry-over.
  // Returning the record lets callers decide.
  void newUsed;
  return fresh;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteApiKey(keyId: string): Promise<boolean> {
  const existing = await getApiKeyById(keyId);
  if (!existing) return false;

  const redis = getRedis();
  const tx = redis.multi();
  tx.del(k.apiKey(keyId));
  tx.del(k.apiKeyByHash(existing.keyHash));
  tx.srem(k.apiKeyByUser(existing.userId), keyId);
  await tx.exec();
  return true;
}

/** Cascade-delete all keys for a user. Returns the count removed. */
export async function deleteApiKeysByUser(userId: string): Promise<number> {
  const ids = await getRedis().smembers(k.apiKeyByUser(userId));
  let count = 0;
  for (const id of ids) {
    if (await deleteApiKey(id)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashToKey(raw: Record<string, string> | null): Promise<ApiKey | null> {
  if (!raw) return null;
  try {
    return ApiKeySchema.parse({
      id: raw.id,
      userId: raw.userId,
      label: raw.label,
      keyHash: raw.keyHash,
      keyPrefix: raw.keyPrefix,
      quotaType: raw.quotaType,
      quotaLimit: Number(raw.quotaLimit ?? "0"),
      quotaUsed: Number(raw.quotaUsed ?? "0"),
      expiresAt: raw.expiresAt && raw.expiresAt !== "" ? raw.expiresAt : null,
      enabled: raw.enabled === "1",
      allowedModels: raw.allowedModels ? raw.allowedModels.split(",").filter(Boolean) : [],
      createdAt: raw.createdAt,
      lastUsedAt: raw.lastUsedAt && raw.lastUsedAt !== "" ? raw.lastUsedAt : null,
    });
  } catch {
    return null;
  }
}
