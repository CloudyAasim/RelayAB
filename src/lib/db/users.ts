/**
 * src/lib/db/users.ts
 *
 * Repository for `User` entities. A user is the human owner of one or
 * more API keys and may have role=admin or role=user.
 *
 * Schema (mirrors `docs/DATA_MODEL.md` §1):
 *   HASH relay:user:{userId}       → User fields
 *   STRING relay:user:by-username:{username} → userId
 *
 * All write operations that affect secondary indexes must be atomic
 * with respect to the primary record. We use Redis MULTI (transactions)
 * to ensure both writes succeed or both fail.
 */
import { hashPassword } from "../crypto/password";
import { generateId } from "../crypto/hashing";
import { UserSchema, DEFAULT_USER_ALLOCATION, type User } from "./types";
import { getRedis, hgetallMany, k } from "./redis";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UsernameConflictError extends Error {
  constructor(public readonly username: string) {
    super(`Username already exists: ${username}`);
    this.name = "UsernameConflictError";
  }
}

export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`User not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  password: string; // plaintext; repository will hash
  role?: "admin" | "user";
  displayName?: string;
  /** Admin-controlled policy applied at creation. Defaults come from
   *  `DEFAULT_USER_ALLOCATION` if not supplied. */
  quotaType?: "credits" | "tokens";
  quotaLimit?: number;
  maxActiveKeys?: number;
  allowedModels?: string[];
}

export interface UpdateUserInput {
  displayName?: string;
  role?: "admin" | "user";
  disabled?: boolean;
  // Admin-controlled policy (see UserSchema).
  quotaType?: "credits" | "tokens";
  quotaLimit?: number;
  /** Admin can also top up / reset consumption. Never settable by the user. */
  quotaUsed?: number;
  maxActiveKeys?: number;
  allowedModels?: string[];
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a new user.
 *
 * Hashes the password with bcrypt (12 rounds) before storage.
 * Throws `UsernameConflictError` if the username is taken.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  const id = generateId();
  const now = new Date().toISOString();

  const user: User = UserSchema.parse({
    id,
    username: input.username,
    passwordHash,
    role: input.role ?? "user",
    displayName: input.displayName ?? input.username,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    disabled: false,
    quotaType: input.quotaType ?? DEFAULT_USER_ALLOCATION.quotaType,
    quotaLimit: input.quotaLimit ?? DEFAULT_USER_ALLOCATION.quotaLimit,
    quotaUsed: 0,
    maxActiveKeys: input.maxActiveKeys ?? DEFAULT_USER_ALLOCATION.maxActiveKeys,
    allowedModels: input.allowedModels ?? [],
  });

  const redis = getRedis();

  // ATOMIC CONFLICT CHECK + RESERVATION.
  //
  // The classic implementation does GET-then-SET, which has a TOCTOU race:
  // two concurrent createUser() calls both observe "no existing user" and
  // both proceed to write, ending up with a duplicated username and an
  // orphaned user record. The fix is to use SETNX on the secondary index:
  // if the SETNX returns "OK" we have atomically reserved the username; if
  // it returns null the username is already taken.
  //
  // Why this matters in production: Vercel cold-starts spin up multiple
  // concurrent Lambda containers, and `bootstrapAdmin()` is invoked from
  // every page-load's `getCurrentUser()`. Without atomic reservation the
  // losing Lambda explodes with "Username already exists: admin" and
  // surfaces as an HTTP 500 to the user.
  const usernameKey = k.userByUsername(user.username);
  const claimed = await redis.set(usernameKey, user.id, { nx: true });
  if (claimed !== "OK") {
    throw new UsernameConflictError(user.username);
  }

  // From here on the username is reserved in the secondary index. If the
  // user hash write that follows fails, we MUST release the reservation
  // (otherwise the username is "stuck taken" forever).
  try {
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
  } catch (err) {
    // Best-effort cleanup. If this DEL also fails (e.g. transient Redis
    // outage), the operator can clear relay:user:by-username:{username}
    // by hand. The error that caused us to land here is the meaningful
    // one — surface it.
    await redis.del(usernameKey).catch(() => {});
    throw err;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Look up a user by id. Returns null if not found. */
export async function getUserById(userId: string): Promise<User | null> {
  if (!userId) return null;
  return hashToUser(await getRedis().hgetall<Record<string, string>>(k.user(userId)));
}

/** Look up a user by username. Returns null if not found. */
export async function getUserByUsername(username: string): Promise<User | null> {
  if (!username) return null;
  const userId = await getRedis().get<string>(k.userByUsername(username));
  if (!userId) return null;
  return getUserById(userId);
}

/** List users (paginated). Cursor is currently `last_user.username` for simplicity. */
export async function listUsers(opts: { limit?: number; cursor?: string } = {}): Promise<{
  users: User[];
  nextCursor: string | null;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const redis = getRedis();
  // Schema reminder:
  //   HASH     relay:user:{userId}            → record
  //   STRING   relay:user:by-username:{u}    → userId  (secondary index)
  // SCAN `relay:user:*` would match BOTH; we filter out the secondary
  // index so we never call HGETALL on a STRING key (which throws
  // WRONGTYPE in real Upstash).
  const [, matched] = await redis.scan(0, { match: `${k.user("")}*`, count: 500 });
  const userKeys = matched.filter(
    (key) => key.startsWith(k.user("")) && !key.startsWith(k.userByUsername("")),
  );

  const users: User[] = [];
  // One pipelined read instead of one round-trip per user record.
  const rows = await hgetallMany(redis, userKeys);
  const parsed = await Promise.all(rows.map((raw) => hashToUser(raw)));
  for (const user of parsed) {
    if (user) users.push(user);
  }
  users.sort((a, b) => a.username.localeCompare(b.username));

  // Apply cursor (skip usernames <= cursor).
  let startIdx = 0;
  if (opts.cursor) {
    const idx = users.findIndex((u) => u.username > opts.cursor!);
    startIdx = idx >= 0 ? idx : users.length;
  }
  const slice = users.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < users.length ? slice[slice.length - 1].username : null;
  return { users: slice, nextCursor };
}

/** Verify a password against the stored hash. Returns the user on match, null otherwise. */
export async function verifyUserCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user || user.disabled) return null;
  const { verifyPassword } = await import("../crypto/password");
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Apply a partial update to a user. Returns the updated user, or null if not found. */
export async function updateUser(
  userId: string,
  patch: UpdateUserInput,
): Promise<User | null> {
  const existing = await getUserById(userId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged: User = {
    ...existing,
    displayName: patch.displayName ?? existing.displayName,
    role: patch.role ?? existing.role,
    disabled: patch.disabled ?? existing.disabled,
    quotaType: patch.quotaType ?? existing.quotaType,
    quotaLimit: patch.quotaLimit ?? existing.quotaLimit,
    quotaUsed: patch.quotaUsed ?? existing.quotaUsed,
    maxActiveKeys: patch.maxActiveKeys ?? existing.maxActiveKeys,
    allowedModels: patch.allowedModels ?? existing.allowedModels,
    updatedAt: now,
  };
  // Re-validate.
  const validated = UserSchema.parse(merged);

  await getRedis().hset(k.user(userId), {
    displayName: validated.displayName,
    role: validated.role,
    disabled: validated.disabled ? "1" : "0",
    quotaType: validated.quotaType,
    quotaLimit: String(validated.quotaLimit),
    quotaUsed: String(validated.quotaUsed),
    maxActiveKeys: String(validated.maxActiveKeys),
    allowedModels: validated.allowedModels.join(","),
    updatedAt: validated.updatedAt,
  });

  return validated;
}

/** Reset a user's password and return the new plaintext. */
export async function resetUserPassword(
  userId: string,
  newPassword: string,
): Promise<User | null> {
  const existing = await getUserById(userId);
  if (!existing) return null;

  const passwordHash = await hashPassword(newPassword);
  const now = new Date().toISOString();
  await getRedis().hset(k.user(userId), {
    passwordHash,
    updatedAt: now,
  });
  return { ...existing, passwordHash, updatedAt: now };
}

/** Record a successful login (updates lastLoginAt timestamp). */
export async function touchLastLogin(userId: string): Promise<void> {
  const now = new Date().toISOString();
  await getRedis().hset(k.user(userId), { lastLoginAt: now });
}

/**
 * Atomically add `delta` to a user's consumed-quota counter.
 *
 * This is the write half of the "quota lives on the user" model: every
 * successful proxied request — no matter which of the user's keys carried
 * it — decrements the same pool. `HINCRBY` keeps concurrent requests from
 * losing updates the way a read-modify-write would.
 *
 * Returns the fresh user record so callers can render remaining balance
 * without a second round trip. Returns null if the user vanished mid-flight.
 */
export async function incrementUserQuotaUsed(
  userId: string,
  delta: number,
): Promise<User | null> {
  if (!Number.isFinite(delta) || delta < 0) {
    throw new RangeError("delta must be a non-negative finite number");
  }
  if (delta === 0) return getUserById(userId);

  await getRedis().hincrby(k.user(userId), "quotaUsed", delta);
  return getUserById(userId);
}

/**
 * Remaining quota for a user, in the same integer unit as `quotaLimit`.
 * Never negative — an overshooting request shows 0 remaining rather than a
 * balance that reads like a debt.
 */
export function remainingQuota(user: Pick<User, "quotaLimit" | "quotaUsed">): number {
  return Math.max(0, user.quotaLimit - user.quotaUsed);
}

/** Soft-delete: mark user as disabled (keeps data for audit). */
export async function disableUser(userId: string): Promise<boolean> {
  const updated = await updateUser(userId, { disabled: true });
  return updated !== null;
}

/** Hard-delete: remove user + all secondary indexes. */
export async function deleteUser(userId: string): Promise<boolean> {
  const existing = await getUserById(userId);
  if (!existing) return false;

  const redis = getRedis();
  const tx = redis.multi();
  tx.del(k.user(userId));
  tx.del(k.userByUsername(existing.username));
  await tx.exec();
  return true;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Create the very first admin if no user exists. Used on initial deploy.
 * Idempotent: returns null if a user already exists.
 */
export async function bootstrapAdminIfNeeded(args: {
  username: string;
  password: string;
}): Promise<User | null> {
  const metaKey = k.metaInitialized();
  const redis = getRedis();
  const already = await redis.get(metaKey);
  if (already) return null;

  const existing = await getUserByUsername(args.username);
  if (existing) {
    await redis.set(metaKey, "1");
    return null;
  }

  const user = await createUser({
    username: args.username,
    password: args.password,
    role: "admin",
    displayName: "Initial Admin",
  });
  await redis.set(metaKey, "1");
  return user;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashToUser(raw: Record<string, string> | null): Promise<User | null> {
  if (!raw) return null;
  try {
    // Allocation fields default if missing (back-compat with records written
    // before the user-allocation feature shipped).
    // Back-compat: records written before quota moved from the key onto the
    // user stored `quotaTypePerKey` / `quotaLimitPerKey`. Read those as the
    // pool so an existing deployment keeps whatever it had granted.
    const quotaType =
      (raw.quotaType as "credits" | "tokens" | undefined) ??
      (raw.quotaTypePerKey as "credits" | "tokens" | undefined) ??
      DEFAULT_USER_ALLOCATION.quotaType;
    const quotaLimit =
      raw.quotaLimit && raw.quotaLimit !== ""
        ? Number(raw.quotaLimit)
        : raw.quotaLimitPerKey && raw.quotaLimitPerKey !== ""
          ? Number(raw.quotaLimitPerKey)
          : DEFAULT_USER_ALLOCATION.quotaLimit;
    const quotaUsed =
      raw.quotaUsed && raw.quotaUsed !== "" ? Number(raw.quotaUsed) : 0;
    const maxActiveKeys =
      raw.maxActiveKeys && raw.maxActiveKeys !== ""
        ? Number(raw.maxActiveKeys)
        : DEFAULT_USER_ALLOCATION.maxActiveKeys;
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
