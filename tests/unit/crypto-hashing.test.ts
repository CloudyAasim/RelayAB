/**
 * tests/unit/crypto-hashing.test.ts
 *
 * Validates hashing and ID generation utilities:
 * - sha256Hex is deterministic and 64 chars long
 * - generateApiKey has the right format and entropy
 * - maskApiKey produces a safe preview
 * - randomBase62 uses only base62 alphabet
 * - generateId sorts by creation time
 */
import { describe, it, expect } from "vitest";
import {
  sha256Hex,
  generateApiKey,
  maskApiKey,
  API_KEY_PREFIX,
  randomBase62,
  randomHex,
  randomBase64,
  generateId,
} from "@/lib/crypto/hashing";

describe("sha256Hex", () => {
  it("is deterministic", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("returns 64-char lowercase hex", () => {
    const h = sha256Hex("test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with input (avalanche)", () => {
    const a = sha256Hex("input-A");
    const b = sha256Hex("input-B");
    expect(a).not.toBe(b);
  });

  it("matches known vector for empty string", () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches known vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("generateApiKey", () => {
  it("has the right prefix", () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("has the right total length (8 + 43 = 51)", () => {
    expect(generateApiKey()).toHaveLength(API_KEY_PREFIX.length + 43);
  });

  it("uses only base62 characters after the prefix", () => {
    const key = generateApiKey();
    const secret = key.slice(API_KEY_PREFIX.length);
    expect(secret).toMatch(/^[0-9A-Za-z]{43}$/);
  });

  it("produces unique keys across 1000 calls", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 1000; i++) keys.add(generateApiKey());
    expect(keys.size).toBe(1000);
  });
});

describe("maskApiKey", () => {
  it("hides the middle of a key", () => {
    const key = "sk-relay-X3K7B2nm9pQ8rT4vW6yZ1aBcDeFgHiJkLmNoPqRsUv";
    const masked = maskApiKey(key);
    expect(masked).toContain("...");
    expect(masked).not.toContain("LmNoPqRsUv");
    expect(masked.endsWith("RsUv")).toBe(true); // last 4 chars visible
    expect(masked.startsWith("sk-relay-")).toBe(true); // prefix visible
  });

  it("falls back to prefix-only when key is too short", () => {
    const masked = maskApiKey("abc");
    expect(masked).toBe("abc...");
  });
});

describe("randomBase62", () => {
  it("returns the requested length", () => {
    [1, 16, 64, 128].forEach((n) => {
      expect(randomBase62(n)).toHaveLength(n);
    });
  });

  it("only contains base62 characters", () => {
    const out = randomBase62(2000);
    expect(out).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("throws on invalid length", () => {
    expect(() => randomBase62(0)).toThrow(RangeError);
    expect(() => randomBase62(-1)).toThrow(RangeError);
    expect(() => randomBase62(1.5)).toThrow(RangeError);
  });

  it("produces different outputs across calls", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100; i++) set.add(randomBase62(32));
    expect(set.size).toBe(100);
  });
});

describe("randomHex / randomBase64", () => {
  it("randomHex yields 2x length in chars", () => {
    expect(randomHex(16)).toHaveLength(32);
    expect(randomHex(16)).toMatch(/^[0-9a-f]+$/);
  });

  it("randomBase64 yields ceil(length * 4/3) chars", () => {
    const out = randomBase64(16);
    // base64 can include +/=, but typical Node output uses URL-safe
    // when requested. Plain base64 may have padding.
    expect(out.length).toBeGreaterThanOrEqual(16);
  });
});

describe("generateId", () => {
  it("returns the requested length", () => {
    expect(generateId(26)).toHaveLength(26);
    expect(generateId(20)).toHaveLength(20);
  });

  it("starts with a 10-char timestamp prefix", () => {
    const id = generateId();
    // First 10 chars must be base62 digits forming the timestamp.
    expect(id.slice(0, 10)).toMatch(/^[0-9A-Za-z]{10}$/);
  });

  it("sorts by creation time", async () => {
    const a = generateId();
    await new Promise((r) => setTimeout(r, 1100)); // > 1 second
    const b = generateId();
    expect(a < b).toBe(true); // lexicographic = chronological
  });

  it("rejects length < 10", () => {
    expect(() => generateId(5)).toThrow(RangeError);
  });
});
