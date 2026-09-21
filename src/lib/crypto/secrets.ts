/**
 * src/lib/crypto/secrets.ts
 *
 * Symmetric encryption for upstream provider API keys at rest.
 *
 * Algorithm: AES-256-GCM (authenticated encryption).
 * - 256-bit key, derived from RELAY_MASTER_KEY_HEX env var.
 * - 96-bit IV (12 bytes), generated fresh per encryption.
 * - 128-bit auth tag.
 *
 * Storage format (base64):
 *   base64( iv (12 bytes) || ciphertext (N bytes) || authTag (16 bytes) )
 *
 * Why AES-256-GCM?
 * - Industry-standard AEAD (authenticated encryption with associated data).
 * - Built-in to Node's `crypto` module via `createCipheriv` / `createDecipheriv`.
 * - Detects any modification: tampered ciphertext fails authentication.
 *
 * Threat model:
 * - If an attacker reads Redis (e.g., via leaked credentials) but does NOT
 *   have access to the env vars, they cannot decrypt provider keys.
 * - If an attacker has both Redis and env vars, all bets are off
 *   (they can re-encrypt with their own master key).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getMasterKey } from "../config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AES block size for IV. NIST SP 800-38D recommends 12 bytes for GCM. */
const IV_BYTES = 12;

/** GCM auth tag length. */
const TAG_BYTES = 16;

/** Key length in bytes (256-bit). */
const KEY_BYTES = 32;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SecretDecryptionError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a string secret (e.g. upstream provider API key).
 *
 * @returns base64-encoded blob: 12-byte IV || ciphertext || 16-byte tag.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new TypeError("encryptSecret: plaintext must be a string");
  }

  const key = getMasterKey();
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Master key must be ${KEY_BYTES} bytes, got ${key.length}. ` +
        `Set RELAY_MASTER_KEY_HEX to 64 hex chars (32 bytes).`,
    );
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: iv (12) || ciphertext (N) || tag (16)
  const blob = Buffer.concat([iv, ciphertext, tag]);
  return blob.toString("base64");
}

/**
 * Decrypt a previously-encrypted secret.
 *
 * @throws SecretDecryptionError on any tampering, malformed blob, or wrong key.
 */
export function decryptSecret(blob: string): string {
  if (typeof blob !== "string") {
    throw new TypeError("decryptSecret: blob must be a string");
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(blob, "base64");
  } catch {
    throw new SecretDecryptionError("Invalid base64 encoding", "malformed");
  }

  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new SecretDecryptionError(
      `Blob too short: ${buf.length} bytes (need >= ${IV_BYTES + TAG_BYTES})`,
      "malformed",
    );
  }

  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);

  const key = getMasterKey();
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Master key must be ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(), // throws if tag mismatches (tampered or wrong key)
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    // Distinguish "wrong key" from generic tampering: GCM final() throws
    // when the auth tag doesn't match. We collapse these to one error
    // for simplicity — the caller should never see the underlying error.
    throw new SecretDecryptionError(
      "Failed to decrypt: wrong key or tampered ciphertext",
      "auth_failed",
    );
  }
}

/**
 * Constant-time string comparison. Used to compare API keys etc.
 * Not strictly needed for AES-GCM (which has built-in auth) but useful
 * elsewhere (e.g. comparing bypass secrets, session tokens).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // Node has crypto.timingSafeEqual but it requires equal-length buffers.
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
