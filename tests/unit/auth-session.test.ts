/**
 * tests/unit/auth-session.test.ts
 *
 * Validates session helpers that don't depend on Next.js:
 * - getSessionOptions reflects the validated config
 * - InMemoryCookieStore round-trips cookies
 * - getSessionFromStore encrypts/decrypts via iron-session correctly
 * - reasonToHttp (sess) live in auth-apikey; we don't duplicate here.
 */
import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  getSessionOptions,
  InMemoryCookieStore,
  getSessionFromStore,
} from "@/lib/auth/session";

describe("session constants", () => {
  it("cookie name is stable", () => {
    expect(SESSION_COOKIE_NAME).toBe("relay_session");
  });
  it("TTL is one week in seconds", () => {
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe("getSessionOptions", () => {
  it("reflects the validated config", () => {
    const opts = getSessionOptions();
    expect(opts.cookieName).toBe(SESSION_COOKIE_NAME);
    expect(typeof opts.password).toBe("string");
    expect((opts.password as string).length).toBeGreaterThanOrEqual(32);
    expect(opts.ttl).toBe(SESSION_TTL_SECONDS);
    expect(opts.cookieOptions?.httpOnly).toBe(true);
    expect(opts.cookieOptions?.sameSite).toBe("lax");
    expect(opts.cookieOptions?.path).toBe("/");
  });
});

describe("InMemoryCookieStore", () => {
  it("set + get roundtrip", () => {
    const s = new InMemoryCookieStore();
    s.set("foo", "bar");
    expect(s.get("foo")).toEqual({ name: "foo", value: "bar" });
  });
  it("returns undefined for missing cookie", () => {
    const s = new InMemoryCookieStore();
    expect(s.get("missing")).toBeUndefined();
  });
  it("supports set with options", () => {
    const s = new InMemoryCookieStore();
    s.set("foo", "bar", { httpOnly: true, path: "/" });
    const entries = s.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].opts?.httpOnly).toBe(true);
  });
  it("clear empties the store", () => {
    const s = new InMemoryCookieStore();
    s.set("a", "1");
    s.set("b", "2");
    s.clear();
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeUndefined();
  });
});

describe("getSessionFromStore (iron-session roundtrip)", () => {
  it("encrypts data on save", async () => {
    const store = new InMemoryCookieStore();
    const session = await getSessionFromStore(store);
    session.userId = "01J";
    session.username = "alice";
    session.role = "admin";
    await session.save();

    // Cookie should be set with a sealed value, not the plaintext
    const cookie = store.get(SESSION_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie!.value).not.toContain("alice");
    expect(cookie!.value.length).toBeGreaterThan(50); // sealed blob is long
  });

  it("decrypts the same data on next load", async () => {
    const store = new InMemoryCookieStore();
    const s1 = await getSessionFromStore(store);
    s1.userId = "01J";
    s1.username = "alice";
    s1.role = "user";
    await s1.save();

    // New session reading the same store should see the saved values.
    const s2 = await getSessionFromStore(store);
    expect(s2.userId).toBe("01J");
    expect(s2.username).toBe("alice");
    expect(s2.role).toBe("user");
  });

  it("destroy clears the cookie", async () => {
    const store = new InMemoryCookieStore();
    const s = await getSessionFromStore(store);
    s.userId = "01J";
    await s.save();
    expect(store.get(SESSION_COOKIE_NAME)).toBeDefined();

    s.destroy();
    // After destroy, the cookie should either be gone or empty.
    const c = store.get(SESSION_COOKIE_NAME);
    expect(c?.value === "" || c === undefined).toBe(true);
  });
});
