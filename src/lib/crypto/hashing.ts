/**
 * src/lib/crypto/hashing.ts
 *
 * Hashing and random-id helpers used across the codebase.
 *
 * What's here:
 * - `sha256Hex` — for storing API key hashes (one-way; irreversible).
 * - `generateApiKey` — produces a customer-facing API key
 *   (format: `sk-relay-` + 43 base62 chars).
 * - `maskApiKey` — returns a safe-to-display prefix/suffix view.
 * - `randomBytes`, `randomBase62`, `randomPassword` — entropy helpers.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 of a string, returned as 64-char lowercase hex.
 *
 * Use this to hash customer API keys before storage: the hash is
 * deterministic and one-way. To verify a key, hash the candidate and
 * compare against the stored hash.
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// API key generation
// ---------------------------------------------------------------------------

/** Characters used for the secret portion of API keys. Base62 = [0-9a-zA-Z]. */
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Length of the secret portion of customer API keys. 43 chars of base62
 * yields ~256 bits of entropy (62^43 ≈ 2^255.9). */
const API_KEY_SECRET_LENGTH = 43;

/** Customer API key prefix. Mirrors OpenAI's `sk-...` convention. */
export const API_KEY_PREFIX = "sk-relay-";

/**
 * Generate a new customer-facing API key.
 *
 * Format: `sk-relay-` + 43 base62 chars.
 * Total length: 52 chars.
 */
export function generateApiKey(): string {
  const secret = randomBase62(API_KEY_SECRET_LENGTH);
  return `${API_KEY_PREFIX}${secret}`;
}

/**
 * Produce a display-safe view of an API key.
 * Example: `sk-relay-X3K7...m2pQ` (first 12 chars + `...` + last 4).
 */
export function maskApiKey(plainKey: string): string {
  if (plainKey.length < API_KEY_PREFIX.length + 8) {
    // Too short to mask meaningfully — return the prefix only.
    return `${plainKey.slice(0, 4)}...`;
  }
  const start = plainKey.slice(0, API_KEY_PREFIX.length + 4); // "sk-relay-XXXX"
  const end = plainKey.slice(-4);
  return `${start}...${end}`;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/**
 * Cryptographically-secure random bytes, returned as hex string.
 * Uses Node's `crypto.randomBytes` under the hood.
 */
export function randomHex(byteLength: number): string {
  return nodeRandomBytes(byteLength).toString("hex");
}

/**
 * Cryptographically-secure random bytes, returned as base64 string.
 */
export function randomBase64(byteLength: number): string {
  return nodeRandomBytes(byteLength).toString("base64");
}

/**
 * Generate a random base62 string of the given length.
 *
 * Each character is chosen independently from a uniform distribution
 * over 0-9a-zA-Z. Length N yields roughly N * log2(62) ≈ N * 5.95 bits
 * of entropy.
 */
export function randomBase62(length: number): string {
  if (length <= 0 || !Number.isInteger(length)) {
    throw new RangeError("length must be a positive integer");
  }

  // Rejection sampling to ensure uniform distribution.
  // We grab ceil(length * 6 / 8) bytes (because each byte gives ~6 bits
  // worth of base62 decisions) and filter out-of-range bytes.
  const bytes = nodeRandomBytes(Math.ceil((length * 6) / 5));
  let out = "";
  let i = 0;
  while (out.length < length && i < bytes.length) {
    const b = bytes[i++];
    if (b < 62 * 4) {
      // b < 248 → first 62 base62 digits each fit in 6 bits, and 248 = 62*4
      // means values 0..247 are all valid. Above that, modulo 62 biases.
      out += BASE62_ALPHABET[b % 62];
    }
  }
  if (out.length < length) {
    // Extremely unlikely; try again with fresh entropy.
    return randomBase62(length);
  }
  return out;
}

/**
 * Generate a random human-readable password.
 *
 * Format: 4 groups of 4 chars separated by dashes. Example:
 * `Ab12-cd34-EF56-gh78`. Uses base62 alphabet so it's URL-safe.
 */
export function randomPassword(): string {
  return [
    randomBase62(4),
    randomBase62(4),
    randomBase62(4),
    randomBase62(4),
  ].join("-");
}

// ---------------------------------------------------------------------------
// ULID-ish id generation
// ---------------------------------------------------------------------------

/**
 * Generate a sortable, URL-safe ID of `length` base62 chars (default 26).
 *
 * Inspired by ULID: lexicographically sortable by time prefix.
 * First 10 chars = ~59 bits of timestamp seconds (good until year ~4253).
 * Last 16 chars = ~95 bits of random entropy.
 *
 * Not a strict ULID (those use Crockford base32, not base62), but
 * the property "sortable by time" holds as long as you don't change
 * the alphabet.
 */
export function generateId(length = 26): string {
  if (length < 10) {
    throw new RangeError("length must be at least 10 to embed a timestamp");
  }
  const ts = Math.floor(Date.now() / 1000);
  const tsEncoded = encodeBase62(BigInt(ts), 10).padStart(10, "0");
  const rest = randomBase62(length - 10);
  return tsEncoded + rest;
}

/**
 * Encode a non-negative BigInt as base62 (no padding, no leading zeros
 * stripping). Caller pads if needed.
 */
function encodeBase62(n: bigint, minLength = 0): string {
  if (n < 0n) throw new RangeError("n must be non-negative");
  if (n === 0n) return "0".padStart(minLength, "0");

  let out = "";
  while (n > 0n) {
    out = BASE62_ALPHABET[Number(n % 62n)] + out;
    n = n / 62n;
  }
  return out.padStart(minLength, "0");
}
