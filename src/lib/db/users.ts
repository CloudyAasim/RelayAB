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
import { UserSchema, type User } from "./types";
import { getRedis, k } from "./redis";

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
}

export interface UpdateUserInput {
  displayName?: string;
  role?: "admin" | "user";
  disabled?: boolean;
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
  });

  const redis = getRedis();

  // Conflict detection: if a user with this username already exists, fail
  // fast before doing any writes. This is racy in theory (TOCTOU) but in
  // practice a 1ms window is acceptable for our admin-driven use case.
  const existingId = await redis.get(k.userByUsername(user.username));
  if (existingId) {
    throw new UsernameConflictError(user.username);
  }

  const tx = redis.multi();
  tx.set(k.userByUsername(user.username), user.id);
  tx.hset(k.user(user.id), {
    id: user.id,
    username: user.username,
    passwordHash: user.passwordHash,
    role: user.role,
    displayName: user.displayName,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt ?? "",
    disabled: user.disabled ? "1" : "0",
  });
  await tx.exec();
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
  const allIds = await getRedis().scan(0, { match: `${k.user("")}*`, count: 200 });
  void allIds;
  // Direct approach: scan for user: keys, then hgetall each.
  // For correctness over efficiency, we use scan + filter.
  const redis = getRedis();
  const [, matched] = await redis.scan(0, { match: `${k.user("").slice(0, -1)}*`, count: 500 });
  const userKeys = matched.filter((key) => key.startsWith(k.user("")));

  const users: User[] = [];
  for (const key of userKeys) {
    const u = await hashToUser(await redis.hgetall<Record<string, string>>(key));
    if (u) users.push(u);
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
    updatedAt: now,
  };
  // Re-validate.
  const validated = UserSchema.parse(merged);

  await getRedis().hset(k.user(userId), {
    displayName: validated.displayName,
    role: validated.role,
    disabled: validated.disabled ? "1" : "0",
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
    });
  } catch {
    return null;
  }
}
