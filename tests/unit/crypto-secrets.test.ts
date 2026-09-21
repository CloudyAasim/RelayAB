/**
 * tests/unit/crypto-secrets.test.ts
 *
 * Validates the AES-256-GCM implementation for upstream key encryption:
 * - roundtrip (encrypt → decrypt) yields the original plaintext
 * - ciphertext is non-deterministic (random IV)
 * - Tampered ciphertext fails authentication
 * - Wrong key fails authentication
 * - Malformed input throws a typed error
 */
import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  SecretDecryptionError,
  timingSafeEqual,
} from "@/lib/crypto/secrets";

describe("encryptSecret / decryptSecret", () => {
  it("roundtrip preserves plaintext", () => {
    const pt = "sk-upstream-openai-abc123def456";
    const ct = encryptSecret(pt);
    expect(ct).not.toBe(pt);
    expect(ct).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    expect(decryptSecret(ct)).toBe(pt);
  });

  it("produces non-deterministic ciphertext (different IV each time)", () => {
    const pt = "sk-same-secret";
    const a = encryptSecret(pt);
    const b = encryptSecret(pt);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(pt);
    expect(decryptSecret(b)).toBe(pt);
  });

  it("handles unicode plaintext correctly", () => {
    const pt = "你好🌍—secret";
    const ct = encryptSecret(pt);
    expect(decryptSecret(ct)).toBe(pt);
  });

  it("rejects empty plaintext", () => {
    // Empty string is valid ciphertext-wise; roundtrip should still work.
    const ct = encryptSecret("");
    expect(decryptSecret(ct)).toBe("");
  });

  it("rejects tampered ciphertext (auth tag fails)", () => {
    const ct = encryptSecret("the-secret");
    const buf = Buffer.from(ct, "base64");
    // Flip one bit in the ciphertext (after IV, before tag).
    const idx = 12 + 5;
    buf[idx] = buf[idx] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it("rejects wrong-key decryption (via env swap)", async () => {
    const { __resetConfigForTest } = await import("@/lib/config");
    const ct = encryptSecret("hi");
    // Now change the master key and try to decrypt.
    process.env.RELAY_MASTER_KEY_HEX = "ff".repeat(32);
    __resetConfigForTest();
    expect(() => decryptSecret(ct)).toThrow(SecretDecryptionError);
    // Restore for subsequent cases.
    process.env.RELAY_MASTER_KEY_HEX = "0".repeat(64);
    __resetConfigForTest();
  });

  it("rejects malformed base64", () => {
    expect(() => decryptSecret("not-valid-base64!!!")).toThrow(
      SecretDecryptionError,
    );
  });

  it("rejects blob that is too short", () => {
    expect(() => decryptSecret("AAAA")).toThrow(SecretDecryptionError);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error testing runtime check
    expect(() => encryptSecret(123)).toThrow(TypeError);
    // @ts-expect-error testing runtime check
    expect(() => decryptSecret(null)).toThrow(TypeError);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });
  it("returns false for different strings", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
  it("returns false for different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
  it("returns false for non-string inputs", () => {
    // @ts-expect-error testing runtime
    expect(timingSafeEqual(null, "x")).toBe(false);
  });
});
