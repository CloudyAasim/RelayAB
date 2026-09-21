/**
 * tests/unit/crypto-password.test.ts
 *
 * Validates password hashing:
 * - hash + verify roundtrip
 * - Different passwords of the same plaintext produce different hashes (salt)
 * - Wrong password returns false
 * - Empty inputs rejected
 * - generateInitialPassword returns properly formatted passwords
 */
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  hashPasswordSync,
  verifyPasswordSync,
  generateInitialPassword,
  BCRYPT_ROUNDS,
} from "@/lib/crypto/password";

describe("hashPassword / verifyPassword (async)", () => {
  it("roundtrip: hash then verify succeeds", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).toMatch(/^\$2[aby]\$12\$/); // bcrypt v2a/b/y, 12 rounds
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
  });

  it("produces different hashes for the same plaintext (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects wrong password", async () => {
    const hash = await hashPassword("right-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("uses the configured work factor", async () => {
    const hash = await hashPassword("test");
    expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_ROUNDS}\\$`));
  });

  it("rejects empty password", async () => {
    await expect(hashPassword("")).rejects.toThrow(TypeError);
  });

  it("rejects too-long password", async () => {
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(RangeError);
  });

  it("verify rejects malformed hash", async () => {
    expect(await verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
  });

  it("verify rejects empty inputs", async () => {
    expect(await verifyPassword("", "$2a$12$xxxx")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  it("verify rejects non-string inputs", async () => {
    // @ts-expect-error runtime check
    expect(await verifyPassword(null, "x")).toBe(false);
    // @ts-expect-error runtime check
    expect(await verifyPassword("x", undefined)).toBe(false);
  });
});

describe("hashPasswordSync / verifyPasswordSync", () => {
  it("roundtrip", () => {
    const hash = hashPasswordSync("sync-test");
    expect(verifyPasswordSync("sync-test", hash)).toBe(true);
    expect(verifyPasswordSync("nope", hash)).toBe(false);
  });
});

describe("generateInitialPassword", () => {
  it("returns 4 groups of 4 chars separated by dashes", () => {
    const pw = generateInitialPassword();
    expect(pw).toMatch(/^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/);
  });

  it("produces different passwords each call", () => {
    const a = generateInitialPassword();
    const b = generateInitialPassword();
    expect(a).not.toBe(b);
  });
});
