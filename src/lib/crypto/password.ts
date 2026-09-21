/**
 * src/lib/crypto/password.ts
 *
 * User password hashing using bcryptjs.
 *
 * Why bcryptjs (not bcrypt)?
 * - Pure-JS implementation: works in any runtime (Node, Edge, browser)
 *   without native bindings. Essential for Vercel serverless.
 * - The default work factor (12 rounds) follows the OWASP recommendation.
 *
 * bcrypt properties:
 * - One-way: hash cannot be reversed to plaintext.
 * - Multiple plaintexts can map to the same hash (collisions are
 *   astronomically rare but theoretically possible).
 * - Salt is embedded in the hash output (`$2a$12$...` format).
 */
import bcrypt from "bcryptjs";
import { randomPassword } from "./hashing";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default work factor: 2^12 = 4096 rounds (OWASP-recommended minimum). */
export const BCRYPT_ROUNDS = 12;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using bcrypt.
 * The returned string is the full bcrypt hash (algorithm + work factor + salt + digest).
 */
export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new TypeError("hashPassword: password must be a non-empty string");
  }
  if (plain.length > 1024) {
    // bcrypt truncates input at 72 bytes anyway; reject longer to surface
    // the mistake early.
    throw new RangeError("hashPassword: password too long (max 1024 chars)");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verify a plaintext password against a stored bcrypt hash.
 * Returns true if the password matches, false otherwise.
 *
 * Runs in constant time relative to the hash (bcrypt's design).
 */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  if (typeof plain !== "string" || typeof hash !== "string") return false;
  if (plain.length === 0 || hash.length === 0) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    // Malformed hash → no match.
    return false;
  }
}

/**
 * Generate a cryptographically-strong random password suitable for
 * admin-issued initial passwords (see DEPLOYMENT.md §3).
 *
 * Format: 4 groups of 4 base62 chars separated by dashes, e.g.
 * `Ab12-cd34-EF56-gh78`. ~96 bits of entropy.
 */
export function generateInitialPassword(): string {
  return randomPassword();
}

// ---------------------------------------------------------------------------
// Sync versions (for tests / scripts)
// ---------------------------------------------------------------------------

export const hashPasswordSync = (plain: string): string =>
  bcrypt.hashSync(plain, BCRYPT_ROUNDS);

export const verifyPasswordSync = (plain: string, hash: string): boolean => {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
};
