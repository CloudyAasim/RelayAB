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
 * A key is a CREDENTIAL, not a wallet. It carries identity (who is calling)
 * and light policy (enabled / expiry / optional model narrowing); the quota
 * pool lives on the owning user, so every key that user holds draws from the
 * same balance. See `DEFAULT_USER_ALLOCATION` in ./types.ts for why.
 *
 * Plaintext keys are NEVER stored: only the sha256 is kept. The plaintext
 * is returned ONCE from createApiKey and is unrecoverable afterwards.
 */
import { sha256Hex, generateApiKey, maskApiKey } from "../crypto/hashing";
import { ApiKeySchema, type ApiKey } from "./types";
import { getRedis, k } from "./redis";
import { mapWithConcurrency } from "./concurrency";
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
  expiresAt?: string | null;
  /** Optional narrowing of the owner's model whitelist. */
  allowedModels?: string[];
}

export interface UpdateApiKeyInput {
  label?: string;
  expiresAt?: string | null;
  allowedModels?: string[];
  enabled?: boolean;
  forceDisabled?: boolean;
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
    expiresAt: input.expiresAt ?? null,
    forceDisabled: false,
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
    expiresAt: apiKey.expiresAt ?? "",
    forceDisabled: apiKey.forceDisabled ? "1" : "0",
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

  // Resolve the key records concurrently — one round-trip per key otherwise.
  const fetched = await mapWithConcurrency(allIds, 16, (id) => getApiKeyById(id));
  const keys = fetched.filter((key): key is ApiKey => key !== null);
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
  // Schema reminder:
  //   HASH   relay:apikey:{keyId}            → record
  //   STRING relay:apikey:hash:{hash}        → keyId  (lookup index)
  //   STRING relay:apikey:by-user:{userId}   → set of keyIds (per-user index)
  // SCAN `relay:apikey:*` would match all of these; we only want the
  // HASH records here. Calling HGETALL on the STRING indexes would
  // throw WRONGTYPE in real Upstash.
  const [, matched] = await redis.scan(0, {
    match: `${k.apiKey("")}*`,
    count: 500,
  });
  const keyIds = matched.filter(
    (key) =>
      key.startsWith(k.apiKey("")) &&
      !key.startsWith(k.apiKeyByHash("")) &&
      !key.startsWith(k.apiKeyByUser("")),
  );

  const out: ApiKey[] = [];
  // One concurrent wave instead of one round-trip per key record.
  const rows = await mapWithConcurrency(keyIds, 16, (key) =>
    redis.hgetall<Record<string, string>>(key),
  );
  const parsed = await Promise.all(rows.map((raw) => hashToKey(raw)));
  for (const key of parsed) {
    if (!key) continue;
    if (opts.userId && key.userId !== opts.userId) continue;
    if (opts.enabledOnly && !key.enabled) continue;
    out.push(key);
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
    expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
    allowedModels: patch.allowedModels ?? existing.allowedModels,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    forceDisabled: patch.forceDisabled === undefined ? existing.forceDisabled : patch.forceDisabled,
  });

  await getRedis().hset(k.apiKey(keyId), {
    label: merged.label,
    expiresAt: merged.expiresAt ?? "",
    allowedModels: merged.allowedModels.join(","),
    enabled: merged.enabled ? "1" : "0",
    forceDisabled: merged.forceDisabled ? "1" : "0",
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
 * Stamp `lastUsedAt` on a key after a successful call.
 *
 * Consumption itself is NOT recorded here — it belongs to the owning user's
 * pool (see `incrementUserQuotaUsed` in ./users.ts). Keeping this function
 * separate makes that split explicit at every call site.
 */
export async function touchApiKeyLastUsed(keyId: string): Promise<void> {
  const now = new Date().toISOString();
  await getRedis().hset(k.apiKey(keyId), { lastUsedAt: now });
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
    const strVal = (v: unknown): string => String(v ?? "");
    return ApiKeySchema.parse({
      id: raw.id,
      userId: raw.userId,
      label: raw.label,
      keyHash: raw.keyHash,
      keyPrefix: raw.keyPrefix,
      expiresAt: raw.expiresAt && raw.expiresAt !== "" ? raw.expiresAt : null,
      forceDisabled: strVal(raw.forceDisabled) === "1",
      enabled: strVal(raw.enabled) === "1",
      allowedModels: raw.allowedModels ? raw.allowedModels.split(",").filter(Boolean) : [],
      createdAt: raw.createdAt,
      lastUsedAt: raw.lastUsedAt && raw.lastUsedAt !== "" ? raw.lastUsedAt : null,
    });
  } catch {
    return null;
  }
}
