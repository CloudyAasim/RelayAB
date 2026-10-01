/**
 * src/lib/db/keys.ts
 *
 * Repository for customer `ApiKey` entities.
 *
 * Schema (mirrors `docs/data-model.md` §2):
 *   TABLE api_keys → one row per key. `key_hash` carries a UNIQUE index and
 *                    is the Bearer-auth lookup; `user_id` is a foreign key
 *                    onto `users(id)` with ON DELETE CASCADE.
 *
 * A key is a CREDENTIAL, not a wallet. It carries identity (who is calling)
 * and light policy (enabled / expiry / optional model narrowing); the quota
 * pool lives on the owning user, so every key that user holds draws from the
 * same balance. See `DEFAULT_USER_ALLOCATION` in ./types.ts for why.
 *
 * Plaintext keys are NEVER stored: only the sha256 is kept. The plaintext
 * is returned ONCE from createApiKey and is unrecoverable afterwards.
 *
 * What the move off Redis actually bought us: the previous version had to keep
 * three structures in step — the record HASH, the `hash:{sha256}` → id lookup
 * STRING, and the `by-user:{id}` SET. Every create and delete therefore needed
 * MULTI plus an "unwind the secondary indexes" path, and any interruption
 * between the two left a key that existed but could not be found, or a
 * dangling index entry pointing at nothing. All three invariants are now
 * expressed as an index, a foreign key and a column, so a write is one
 * statement and there is no second structure left to drift.
 */
import { sha256Hex, generateApiKey, maskApiKey, generateId } from "../crypto/hashing";
import { ApiKeySchema, type ApiKey } from "./types";
import { getAll, getOne, rowToApiKey, run, toDbBool, withTransaction } from "./sqlite";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiKeyNotFoundError extends Error {
  constructor(public readonly keyId: string) {
    super(`API key not found: ${keyId}`);
    this.name = "ApiKeyNotFoundError";
  }
}

/**
 * The freshly generated plaintext hashed to a value some existing key already
 * owns. Cryptographically near-impossible (sha256 over ~256 bits of entropy),
 * so it means the generator misbehaved — surfaced rather than retried, because
 * silently minting a second key with the same secret would be worse.
 */
export class ApiKeyHashConflictError extends Error {
  constructor() {
    super("Generated API key hash collides with an existing key");
    this.name = "ApiKeyHashConflictError";
  }
}

/**
 * The requested owner does not exist.
 *
 * Redis had no referential integrity, so a key minted against a mistyped or
 * already-deleted user id simply stored an unownable record. `foreign_keys` is
 * ON (see ./sqlite.ts), so the INSERT is rejected; this turns that into a
 * domain error instead of a raw driver failure leaking out of the repository.
 */
export class ApiKeyOwnerNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`Cannot create an API key for a user that does not exist: ${userId}`);
    this.name = "ApiKeyOwnerNotFoundError";
  }
}

/**
 * `node:sqlite` reports constraint failures as a plain Error carrying the
 * constraint name in the message (there is no typed error code to match on),
 * so both checks are message probes that turn a raw driver error back into the
 * domain error callers already handle. Same approach as `isUniqueViolation` in
 * ./users.ts.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message);
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

  // ONE STATEMENT, AND DELIBERATELY NO TRANSACTION.
  //
  // The Redis version wrote the record HASH, the hash→id lookup and the
  // per-user SET, so MULTI was the only way to keep them consistent — and it
  // still had no real duplicate protection, because a plain SET on the lookup
  // index silently overwrote the previous owner and orphaned the older key,
  // which then could never authenticate again. The UNIQUE index on
  // `key_hash` rejects that atomically, and a lone INSERT cannot half-apply,
  // so there is nothing left for a transaction to buy.
  try {
    run(
      `INSERT INTO api_keys
         (id, user_id, label, key_hash, key_prefix, expires_at,
          force_disabled, enabled, allowed_models, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        apiKey.id,
        apiKey.userId,
        apiKey.label,
        apiKey.keyHash,
        apiKey.keyPrefix,
        apiKey.expiresAt,
        toDbBool(apiKey.forceDisabled),
        toDbBool(apiKey.enabled),
        JSON.stringify(apiKey.allowedModels),
        apiKey.createdAt,
        apiKey.lastUsedAt,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiKeyHashConflictError();
    if (isForeignKeyViolation(err)) throw new ApiKeyOwnerNotFoundError(apiKey.userId);
    throw err;
  }

  return { key: apiKey, plainKey: plain };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Look up a key by id. Returns null if not found. */
export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  if (!keyId) return null;
  return getOne("SELECT * FROM api_keys WHERE id = ?", [keyId], rowToApiKey);
}

/**
 * Look up an API key by the plaintext.
 * This is the hot path during Bearer authentication.
 *
 * Was two Redis round trips — read the `hash:{sha256}` → id pointer, then
 * HGETALL the record. It is now one lookup on the UNIQUE index of `key_hash`
 * that returns the row itself, so the hot path halves its round trips and
 * cannot observe a pointer whose target has since been deleted.
 */
export async function getApiKeyByPlaintext(plaintext: string): Promise<ApiKey | null> {
  if (!plaintext) return null;
  return getOne("SELECT * FROM api_keys WHERE key_hash = ?", [sha256Hex(plaintext)], rowToApiKey);
}

/**
 * List all keys for a user (paginated). Cursor is the last `id` of a page.
 *
 * `user_id` is indexed (`idx_api_keys_user`), so this replaces the SMEMBERS
 * of the per-user SET plus a pipelined HGETALL of every member — and, because
 * the page is cut by SQL, memory use no longer scales with the user's key
 * count.
 *
 * The cursor is `id` and the sort key is `id`. The Redis version sorted by
 * `createdAt` but then sought the cursor with `keys.findIndex(k => k.id >
 * cursor)` — an id comparison against a createdAt-ordered array, so a cursor
 * could skip rows or replay them. `generateId()` is time-sortable, so ordering
 * by `id` is still creation order, just coherent with the cursor this time.
 */
export async function listApiKeysByUser(
  userId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ keys: ApiKey[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  // Fetch one extra row to learn whether another page exists without a second
  // COUNT query.
  const rows = getAll(
    opts.cursor
      ? "SELECT * FROM api_keys WHERE user_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
      : "SELECT * FROM api_keys WHERE user_id = ? ORDER BY id ASC LIMIT ?",
    opts.cursor ? [userId, opts.cursor, limit + 1] : [userId, limit + 1],
    rowToApiKey,
  );

  const hasMore = rows.length > limit;
  const keys = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (keys[keys.length - 1]?.id ?? null) : null;
  return { keys, nextCursor };
}

/**
 * List all keys (admin view). Newest first.
 *
 * The Redis version SCANned the keyspace and had to filter its own index keys
 * back out of the results before reading the survivors, because
 * `relay:apikey:*` matched the hash and by-user prefixes too and a blind
 * HGETALL on one of those throws WRONGTYPE. The filters are now `WHERE`
 * clauses, so the prefix bookkeeping — and the class of bug it invited — is
 * gone. Note there is deliberately no default cap: the admin dashboards call
 * this with no options and expect every key.
 */
export async function listAllApiKeys(opts: {
  limit?: number;
  userId?: string;
  enabledOnly?: boolean;
} = {}): Promise<ApiKey[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.userId) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.enabledOnly) {
    // Stated as a literal rather than a parameter: `enabled` is an INTEGER
    // column, so there is no boolean binding to normalise here.
    where.push("enabled = 1");
  }

  const hasLimit = typeof opts.limit === "number" && opts.limit > 0;
  if (hasLimit) params.push(opts.limit);

  return getAll(
    `SELECT * FROM api_keys` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY created_at DESC` +
      (hasLimit ? ` LIMIT ?` : ""),
    params,
    rowToApiKey,
  );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Apply a partial update to a key. Returns the updated key, or null if the
 * key does not exist.
 *
 * Runs inside a transaction because the merge is a read-modify-write:
 * `withTransaction` opens with BEGIN IMMEDIATE, so the write lock is held
 * before the read and a concurrent update to the same key cannot land in
 * between and be silently overwritten. The Redis version left that window
 * open, since HGETALL-then-HSET was never atomic. The FK means a key can also
 * no longer vanish between the two statements in a way that leaves a partial
 * write.
 */
export async function updateApiKey(
  keyId: string,
  patch: UpdateApiKeyInput,
): Promise<ApiKey | null> {
  return withTransaction(async () => {
    const existing = await getApiKeyById(keyId);
    if (!existing) return null;

    const merged: ApiKey = ApiKeySchema.parse({
      ...existing,
      label: patch.label ?? existing.label,
      expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
      allowedModels: patch.allowedModels ?? existing.allowedModels,
      enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
      forceDisabled:
        patch.forceDisabled === undefined ? existing.forceDisabled : patch.forceDisabled,
    });

    // Re-validate via ApiKeySchema above, then persist every mutable column in
    // one statement. Fields outside the patch (key_hash, key_prefix,
    // createdAt, lastUsedAt) are deliberately not written: a partial HSET had
    // to enumerate them just to avoid clobbering them.
    run(
      `UPDATE api_keys
          SET label = ?, expires_at = ?, allowed_models = ?,
              enabled = ?, force_disabled = ?
        WHERE id = ?`,
      [
        merged.label,
        merged.expiresAt,
        JSON.stringify(merged.allowedModels),
        toDbBool(merged.enabled),
        toDbBool(merged.forceDisabled),
        keyId,
      ],
    );

    return merged;
  });
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
  run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, keyId]);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Hard-delete one key. Returns true if a row was removed.
 *
 * The Redis version read the record, then used MULTI to drop the HASH, the
 * hash→id pointer and the SET membership — three writes that could disagree
 * with each other, and whose failure modes were exactly "key still
 * authenticates" or "index entry outlives its key". All of that is now the
 * one row, so `changes` is both the delete and the existence check.
 */
export async function deleteApiKey(keyId: string): Promise<boolean> {
  return run("DELETE FROM api_keys WHERE id = ?", [keyId]) > 0;
}

/**
 * Delete all keys for a user. Returns the count removed.
 *
 * One statement, and `changes` is an exact count. The Redis version walked
 * the per-user SET and deleted members one at a time, so the number it
 * returned silently excluded any key whose SET entry had drifted away from
 * its record — a user could be told 3 keys were removed when 5 existed.
 *
 * Callers still invoke this before `deleteUser()`, and the result is the
 * number they report, so the behaviour is unchanged for them. Note the FK's
 * ON DELETE CASCADE now covers the same ground: deleting the user alone would
 * already remove these rows, which closes the window between the two
 * statements in a route handler.
 */
export async function deleteApiKeysByUser(userId: string): Promise<number> {
  return run("DELETE FROM api_keys WHERE user_id = ?", [userId]);
}
