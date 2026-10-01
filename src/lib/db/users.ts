/**
 * src/lib/db/users.ts
 *
 * Repository for `User` entities. A user is the human owner of one or
 * more API keys and may have role=admin or role=user.
 *
 * Schema (mirrors `docs/data-model.md` §1):
 *   TABLE users → one row per user, `username` carries a UNIQUE index.
 *
 * The secondary index that used to be a separate `relay:user:by-username:*`
 * STRING key is now the UNIQUE constraint on the `username` column, so the
 * conflict check and the insert are one statement and cannot race.
 */
import { hashPassword } from "../crypto/password";
import { generateId } from "../crypto/hashing";
import { UserSchema, DEFAULT_USER_ALLOCATION, DEFAULT_TIMEZONE, type User, type Timezone } from "./types";
import { getAll, getDb, getOne, rowToUser, run } from "./sqlite";

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

/**
 * True when SQLite rejected a write because a UNIQUE index was violated.
 *
 * `node:sqlite` surfaces constraint failures as a plain Error whose message
 * carries the constraint name, so the check is on the message rather than on a
 * typed error code. Used to turn a raw driver error back into the domain error
 * callers already handle.
 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  password: string; // plaintext; repository will hash
  role?: "admin" | "user";
  displayName?: string;
  /** Per-user display timezone; defaults to Shanghai. */
  timezone?: Timezone;
  /** Admin-controlled policy applied at creation. Defaults come from
   *  `DEFAULT_USER_ALLOCATION` if not supplied. */
  quotaType?: "credits" | "tokens";
  quotaLimit?: number;
  maxActiveKeys?: number;
  allowedModels?: string[];
}

export interface UpdateUserInput {
  displayName?: string;
  /** Per-user display timezone (self-service). */
  timezone?: Timezone;
  role?: "admin" | "user";
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
    timezone: input.timezone ?? DEFAULT_TIMEZONE,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    quotaType: input.quotaType ?? DEFAULT_USER_ALLOCATION.quotaType,
    quotaLimit: input.quotaLimit ?? DEFAULT_USER_ALLOCATION.quotaLimit,
    quotaUsed: 0,
    maxActiveKeys: input.maxActiveKeys ?? DEFAULT_USER_ALLOCATION.maxActiveKeys,
    allowedModels: input.allowedModels ?? [],
  });

  // ATOMIC CONFLICT CHECK + INSERT.
  //
  // The Redis version needed SETNX on a secondary index to avoid a TOCTOU
  // race between two concurrent createUser() calls. Here the UNIQUE index on
  // `username` makes the check and the write a single statement, so the race
  // cannot exist — and the secondary index can no longer drift out of sync
  // with the record it points at.
  try {
    run(
      `INSERT INTO users
         (id, username, password_hash, role, display_name, timezone,
          created_at, updated_at, last_login_at, quota_type, quota_limit,
          quota_used, max_active_keys, allowed_models)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        user.displayName,
        user.timezone ?? DEFAULT_TIMEZONE,
        user.createdAt,
        user.updatedAt,
        null,
        user.quotaType,
        user.quotaLimit,
        user.quotaUsed,
        user.maxActiveKeys,
        JSON.stringify(user.allowedModels),
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new UsernameConflictError(user.username);
    }
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
  return getOne("SELECT * FROM users WHERE id = ?", [userId], rowToUser);
}

/** Look up a user by username. Returns null if not found. */
export async function getUserByUsername(username: string): Promise<User | null> {
  if (!username) return null;
  return getOne("SELECT * FROM users WHERE username = ?", [username], rowToUser);
}

/**
 * List users (paginated). Cursor is `last_user.username` for simplicity.
 *
 * The Redis version SCANned the whole keyspace and filtered out the secondary
 * index before reading each record, because a blind HGETALL on an index key
 * throws WRONGTYPE. Here it is one indexed query, and pagination is a real
 * `LIMIT`/`WHERE` instead of "read everything, then slice".
 */
export async function listUsers(opts: { limit?: number; cursor?: string } = {}): Promise<{
  users: User[];
  nextCursor: string | null;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

  // Fetch one extra row to learn whether another page exists without a
  // second COUNT query.
  const rows = getAll(
    opts.cursor
      ? "SELECT * FROM users WHERE username > ? ORDER BY username ASC LIMIT ?"
      : "SELECT * FROM users ORDER BY username ASC LIMIT ?",
    opts.cursor ? [opts.cursor, limit + 1] : [limit + 1],
    rowToUser,
  );

  const hasMore = rows.length > limit;
  const users = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (users[users.length - 1]?.username ?? null) : null;
  return { users, nextCursor };
}

/** Verify a password against the stored hash. Returns the user on match, null otherwise. */
export async function verifyUserCredentials(
  username: string,
  password: string,
): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user) return null;
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
    timezone: patch.timezone ?? existing.timezone,
    role: patch.role ?? existing.role,
    quotaType: patch.quotaType ?? existing.quotaType,
    quotaLimit: patch.quotaLimit ?? existing.quotaLimit,
    quotaUsed: patch.quotaUsed ?? existing.quotaUsed,
    maxActiveKeys: patch.maxActiveKeys ?? existing.maxActiveKeys,
    allowedModels: patch.allowedModels ?? existing.allowedModels,
    updatedAt: now,
  };
  // Re-validate.
  const validated = UserSchema.parse(merged);

  run(
    `UPDATE users SET
       display_name = ?, timezone = ?, role = ?, quota_type = ?,
       quota_limit = ?, quota_used = ?, max_active_keys = ?,
       allowed_models = ?, updated_at = ?
     WHERE id = ?`,
    [
      validated.displayName,
      validated.timezone ?? DEFAULT_TIMEZONE,
      validated.role,
      validated.quotaType,
      validated.quotaLimit,
      validated.quotaUsed,
      validated.maxActiveKeys,
      JSON.stringify(validated.allowedModels),
      validated.updatedAt,
      userId,
    ],
  );

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
  run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
    passwordHash,
    now,
    userId,
  ]);
  return { ...existing, passwordHash, updatedAt: now };
}

/** Record a successful login (updates lastLoginAt timestamp). */
export async function touchLastLogin(userId: string): Promise<void> {
  const now = new Date().toISOString();
  run("UPDATE users SET last_login_at = ? WHERE id = ?", [now, userId]);
}

/**
 * Atomically add `delta` to a user's consumed-quota counter.
 *
 * This is the write half of the "quota lives on the user" model: every
 * successful proxied request — no matter which of the user's keys carried
 * it — decrements the same pool. Doing the arithmetic in the UPDATE statement
 * keeps concurrent requests from losing updates the way a read-modify-write
 * would.
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

  run("UPDATE users SET quota_used = quota_used + ? WHERE id = ?", [delta, userId]);
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

/** Hard-delete: remove the user. Cascades to their API keys via the FK. */
export async function deleteUser(userId: string): Promise<boolean> {
  return run("DELETE FROM users WHERE id = ?", [userId]) > 0;
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
  // The Redis version set a `meta:initialized` flag with SETNX. Here the
  // PRIMARY KEY on `meta.key` gives the same once-only guarantee: a second
  // concurrent insert violates it and is ignored.
  const already = getOne<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
    ["initialized"],
  );
  if (already) return null;

  const existing = await getUserByUsername(args.username);
  if (existing) {
    run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", ["initialized", "1"]);
    return null;
  }

  const user = await createUser({
    username: args.username,
    password: args.password,
    role: "admin",
    displayName: "Initial Admin",
  });
  run("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", ["initialized", "1"]);
  return user;
}

// Keep the connection import referenced for type-checkers that prune unused
// imports differently across bundlers; getDb is used by the transaction paths.
void getDb;
