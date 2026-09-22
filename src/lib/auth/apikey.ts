/**
 * src/lib/auth/apikey.ts
 *
 * Customer API key authentication.
 *
 * Flow:
 *   1. Parse `Authorization: Bearer <key>` from the request.
 *   2. Hash the key (sha256) → look up the key id in Redis.
 *   3. Fetch the full key record (quota, allowed models, expiry, ...).
 *   4. Run validation:
 *        a) Key.enabled?
 *        c) quotaUsed < quotaLimit?
 *        d) allowedModels includes the requested model?
 *
 *   On success: returns `{ ok: true, key, user }`.
 *   On failure: returns `{ ok: false, reason }` with a machine-readable
 *                code that maps to a specific HTTP error.
 */
import { sha256Hex } from "../crypto/hashing";
import { getRedis, k } from "../db/redis";
import { ensureBootstrapped } from "../db/bootstrap";
import {
  ApiKeySchema,
  UserSchema,
  type ApiKey,
  type User,
  type KeyValidationResult,
} from "../db/types";

// ---------------------------------------------------------------------------
// Bearer parsing
// ---------------------------------------------------------------------------

/**
 * Extract the Bearer token from an `Authorization` header value.
 * Returns null if the header is missing, malformed, or empty.
 *
 *   parseBearer("Bearer sk-relay-xxx")  → "sk-relay-xxx"
 *   parseBearer("bearer sk-relay-xxx")  → "sk-relay-xxx"   (case-insensitive)
 *   parseBearer("Basic dXNlcjpwYXNz")   → null
 *   parseBearer(undefined)              → null
 *   parseBearer("")                     → null
 */
export function parseBearer(authHeader: string | null | undefined): string | null {
  if (!authHeader || typeof authHeader !== "string") return null;
  const trimmed = authHeader.trim();
  if (trimmed.length < 7) return null; // "Bearer " + at least 1 char

  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return null;

  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== "bearer") return null;

  const token = trimmed.slice(spaceIdx + 1).trim();
  if (token.length === 0) return null;

  return token;
}

// ---------------------------------------------------------------------------
// Key lookup
// ---------------------------------------------------------------------------

/**
 * Look up a customer API key by the plaintext.
 *
 * Returns null if:
 *   - The token is malformed (missing prefix, wrong length).
 *   - The sha256 hash isn't in Redis (unknown key).
 *   - The stored record fails schema validation (corruption).
 */
export async function lookupApiKey(
  plaintext: string,
): Promise<ApiKey | null> {
  if (!plaintext || !plaintext.startsWith("sk-relay-")) return null;

  const hash = sha256Hex(plaintext);
  const redis = getRedis();

  const keyId = await redis.get<string>(k.apiKeyByHash(hash));
  if (!keyId) return null;

  const raw = await redis.hgetall<Record<string, string>>(k.apiKey(keyId));
  if (!raw) return null;

  // Convert Redis hash to typed record. The repository layer in M4 will
  // own this; for now we inline the parsing here to keep M3 self-contained.
  return parseApiKeyFromHash(raw);
}

/**
 * Look up a user by id. Returns null if not found or malformed.
 */
export async function lookupUserById(userId: string): Promise<User | null> {
  if (!userId) return null;
  const redis = getRedis();
  const raw = await redis.hgetall<Record<string, string>>(k.user(userId));
  if (!raw) return null;
  return parseUserFromHash(raw);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the API key is currently usable.
 *
 * Order of checks (early returns, cheap to expensive):
 *   1. key.enabled
 *   2. key.expiresAt
 *   3. owner account still enabled
 *   4. the OWNER's quota pool still has headroom
 *   5. model permission — intersection of owner whitelist and key whitelist
 *
 * Step 4 is the architecturally important one: quota is checked against the
 * user, not the key, so minting extra keys does not mint extra budget.
 */
export function checkKeyStatus(args: {
  key: ApiKey;
  user?: User;
  requestedModel?: string;
  now?: number;
}): KeyValidationResult {
  const { key, user, requestedModel, now = Date.now() } = args;

  // Admin override first: a force-disabled key must never serve traffic, even
  // if the `enabled` flag is still true (the admin API can set the flag on its
  // own, and only relying on `enabled` made that a silent no-op).
  if (key.forceDisabled) {
    return { ok: false, reason: "key_force_disabled", key, user };
  }

  if (!key.enabled) {
    return { ok: false, reason: "key_disabled", key };
  }

  if (key.expiresAt && Date.parse(key.expiresAt) <= now) {
    return { ok: false, reason: "key_expired", key };
  }

  if (user) {
    if (user.disabled) {
      return { ok: false, reason: "user_disabled", key, user };
    }
    if (user.quotaUsed >= user.quotaLimit) {
      return {
        ok: false,
        reason:
          user.quotaType === "tokens"
            ? "quota_exceeded_tokens"
            : "quota_exceeded_credits",
        key,
        user,
      };
    }
  }

  if (requestedModel) {
    // The owner's whitelist is the outer bound; a key may narrow it further
    // but can never widen it. An empty list at either level means "no
    // additional restriction here".
    const ownerAllows =
      !user ||
      user.allowedModels.length === 0 ||
      user.allowedModels.includes(requestedModel);
    const keyAllows =
      key.allowedModels.length === 0 || key.allowedModels.includes(requestedModel);
    if (!ownerAllows || !keyAllows) {
      return { ok: false, reason: "model_not_allowed", key, user };
    }
  }

  return { ok: true, reason: "ok", key, user };
}

/**
 * High-level: look up the key by Bearer token AND validate it.
 * Returns the user too so callers can attribute the request.
 */
export async function authenticateBearer(args: {
  authHeader: string | null | undefined;
  requestedModel?: string;
}): Promise<KeyValidationResult> {
  const token = parseBearer(args.authHeader);
  if (!token) {
    return { ok: false, reason: "missing_key" };
  }

  // Fresh-instance self-heal (memoized): the very first proxied call after a
  // cold start may be the first request the instance ever sees.
  await ensureBootstrapped();

  const key = await lookupApiKey(token);
  if (!key) {
    return { ok: false, reason: "key_not_found" };
  }

  const user = await lookupUserById(key.userId);

  // The owner has to be resolved before validation because the quota pool and
  // the model whitelist both live on the user record.
  const result = checkKeyStatus({
    key,
    user: user ?? undefined,
    requestedModel: args.requestedModel,
  });
  return { ...result, user: user ?? undefined };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an API key record from a Redis hash.
 * Internal to this module; the M4 repository will own this.
 */
function parseApiKeyFromHash(raw: Record<string, string>): ApiKey | null {
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

function parseUserFromHash(raw: Record<string, string>): User | null {
  try {
    // Back-compat: pre-pool records kept the allocation under
    // `quotaTypePerKey` / `quotaLimitPerKey`.
    const quotaType =
      (raw.quotaType as "credits" | "tokens" | undefined) ??
      (raw.quotaTypePerKey as "credits" | "tokens" | undefined) ??
      "credits";
    const quotaLimit =
      raw.quotaLimit && raw.quotaLimit !== ""
        ? Number(raw.quotaLimit)
        : raw.quotaLimitPerKey && raw.quotaLimitPerKey !== ""
          ? Number(raw.quotaLimitPerKey)
          : 0;
    const quotaUsed =
      raw.quotaUsed && raw.quotaUsed !== "" ? Number(raw.quotaUsed) : 0;
    const maxActiveKeys =
      raw.maxActiveKeys && raw.maxActiveKeys !== ""
        ? Number(raw.maxActiveKeys)
        : 0;
    const allowedModels = raw.allowedModels
      ? raw.allowedModels.split(",").filter(Boolean)
      : [];
    return UserSchema.parse({
      id: raw.id,
      username: raw.username,
      passwordHash: raw.passwordHash,
      role: raw.role,
      displayName: raw.displayName,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      lastLoginAt: raw.lastLoginAt && raw.lastLoginAt !== "" ? raw.lastLoginAt : null,
      disabled: raw.disabled === "1",
      quotaType,
      quotaLimit,
      quotaUsed,
      maxActiveKeys,
      allowedModels,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

/**
 * Map a validation failure reason to (HTTP status, error code, message).
 */
export function reasonToHttp(reason: string): { status: number; code: string; message: string } {
  switch (reason) {
    case "missing_key":
      return { status: 401, code: "unauthorized", message: "Missing Authorization: Bearer <key>" };
    case "key_not_found":
      return { status: 401, code: "unauthorized", message: "Invalid API key" };
    case "key_disabled":
      return { status: 403, code: "key_disabled", message: "This API key has been disabled" };
    case "key_force_disabled":
      return {
        status: 403,
        code: "key_force_disabled",
        message: "This API key has been disabled by an administrator",
      };
    case "key_expired":
      return { status: 403, code: "key_expired", message: "This API key has expired" };
    case "user_disabled":
      return {
        status: 403,
        code: "user_disabled",
        message: "The account that owns this key has been disabled",
      };
    case "quota_exceeded_credits":
      return {
        status: 403,
        code: "quota_exceeded_credits",
        message: "积分 balance exhausted for this account",
      };
    case "quota_exceeded_tokens":
      return {
        status: 403,
        code: "quota_exceeded_tokens",
        message: "Token quota exhausted for this account",
      };
    case "model_not_allowed":
      return { status: 403, code: "model_not_allowed", message: "This key is not permitted to call this model" };
    default:
      return { status: 500, code: "internal_error", message: "Unknown validation failure" };
  }
}
