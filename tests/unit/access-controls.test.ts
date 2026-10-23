/**
 * tests/unit/access-controls.test.ts
 *
 * Two locks on a key that a password does not provide: **where** it may be
 * used from, and **how fast**.
 *
 * Both live on the account rather than on the key, and both are worth pinning:
 * an allowlist that matches nothing and a rate limit that never fires are the
 * two ways a security control can be present and useless.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  ipAllowed,
  ipRuleProblem,
  parseIpAllowlist,
  normalizeIp,
  clientIpFromHeaders,
} from "@/lib/auth/ip-allowlist";
import { consumeUserRequestSlot } from "@/lib/auth/rate-limit";
import { checkKeyStatus } from "@/lib/auth/apikey";
import { __resetDbForTest, run } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { ApiKey, User } from "@/lib/db/types";

function key(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1",
    userId: "u1",
    label: "test",
    keyHash: "h",
    keyPrefix: "sk-relay-xxxx",
    expiresAt: null,
    forceDisabled: false,
    enabled: true,
    allowedModels: [],
    allowedIps: [],
    createdAt: "2026-10-23T00:00:00.000Z",
    lastUsedAt: null,
    ...over,
  } as ApiKey;
}

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    username: "u",
    passwordHash: "$2a$12$x",
    role: "user",
    displayName: "U",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    lastLoginAt: null,
    quotaType: "credits",
    quotaLimit: 1000,
    quotaUsed: 0,
    maxActiveKeys: 0,
    allowedModels: [],
    rpmLimit: 0,
    ...over,
  } as User;
}

describe("the client address", () => {
  it("takes the first entry of x-forwarded-for", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to nothing", () => {
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
    expect(clientIpFromHeaders(new Headers())).toBe("");
  });

  it("unwraps an IPv4 address that arrived inside IPv6", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("the allowlist rules", () => {
  it("allows everything when there is no list", () => {
    expect(ipAllowed("203.0.113.7", [])).toBe(true);
  });

  it("matches an exact address", () => {
    expect(ipAllowed("203.0.113.7", ["203.0.113.7"])).toBe(true);
    expect(ipAllowed("203.0.113.8", ["203.0.113.7"])).toBe(false);
  });

  it("matches inside an IPv4 network", () => {
    expect(ipAllowed("203.0.113.7", ["203.0.113.0/24"])).toBe(true);
    expect(ipAllowed("203.0.114.7", ["203.0.113.0/24"])).toBe(false);
  });

  it("matches an IPv6 address exactly", () => {
    expect(ipAllowed("::1", ["::1"])).toBe(true);
    expect(ipAllowed("::2", ["::1"])).toBe(false);
  });

  it("refuses an address that is not on the list", () => {
    expect(ipAllowed("198.51.100.1", ["203.0.113.7"])).toBe(false);
  });

  it("refuses when the address is unknown and the list is not empty", () => {
    // A key with an allowlist must not become usable from everywhere because
    // the proxy did not say where the request came from.
    expect(ipAllowed("", ["203.0.113.7"])).toBe(false);
  });

  it("splits a stored list on commas, semicolons and newlines", () => {
    expect(parseIpAllowlist("203.0.113.7, 198.51.100.1\n203.0.113.0/24")).toEqual([
      "203.0.113.7",
      "198.51.100.1",
      "203.0.113.0/24",
    ]);
  });

  it("accepts rules it can honour", () => {
    expect(ipRuleProblem("203.0.113.7")).toBeNull();
    expect(ipRuleProblem("203.0.113.0/24")).toBeNull();
    expect(ipRuleProblem("203.0.113.0/0")).toBeNull();
  });

  it("refuses a rule it cannot honour rather than storing it silently", () => {
    expect(ipRuleProblem("not-an-address")).toBeTruthy();
    expect(ipRuleProblem("203.0.113.0/33")).toBeTruthy();
    // An IPv6 network is not supported, and saying so is better than storing
    // a rule that looks like it works and does not.
    expect(ipRuleProblem("2001:db8::/32")).toBeTruthy();
  });
});

describe("the key check", () => {
  it("refuses a request from an address that is not on the list", () => {
    const result = checkKeyStatus({
      key: key({ allowedIps: ["203.0.113.7"] }),
      user: user(),
      clientIp: "198.51.100.1",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ip_not_allowed");
  });

  it("allows a request from an address that is on the list", () => {
    const result = checkKeyStatus({
      key: key({ allowedIps: ["203.0.113.0/24"] }),
      user: user(),
      clientIp: "203.0.113.7",
    });
    expect(result.ok).toBe(true);
  });

  it("allows any address for a key without a list", () => {
    const result = checkKeyStatus({
      key: key(),
      user: user(),
      clientIp: "198.51.100.1",
    });
    expect(result.ok).toBe(true);
  });
});

describe("the request rate limit", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("lets the requests through until the budget is spent", async () => {
    for (let i = 0; i < 3; i++) {
      const decision = await consumeUserRequestSlot("u-rate", 3);
      expect(decision.allowed, `request ${i + 1}`).toBe(true);
    }
    const refused = await consumeUserRequestSlot("u-rate", 3);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each user separately", async () => {
    for (let i = 0; i < 2; i++) {
      await consumeUserRequestSlot("u-a", 2);
    }
    expect((await consumeUserRequestSlot("u-a", 2)).allowed).toBe(false);
    // One account's traffic is not another's problem — that is the whole
    // point of putting the limit on the account.
    expect((await consumeUserRequestSlot("u-b", 2)).allowed).toBe(true);
  });

  it("treats a limit of zero as no limit at all", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await consumeUserRequestSlot("u-free", 0)).allowed).toBe(true);
    }
  });
});

describe("the limit on the account, not on the key", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("counts every key of the account against the same budget", async () => {
    // The reason it is on the account: a limit on the key is undone by
    // minting another key, and the thing worth protecting is the upstream
    // provider's quota rather than the key.
    const created = await createUser({
      username: "rate-owner",
      password: "x",
      quotaLimit: 1000,
      rpmLimit: 2,
    });
    expect(created.rpmLimit).toBe(2);
    expect(
      await consumeUserRequestSlot(created.id, created.rpmLimit),
    ).toMatchObject({ allowed: true });
    await consumeUserRequestSlot(created.id, created.rpmLimit);
    expect(
      await consumeUserRequestSlot(created.id, created.rpmLimit),
    ).toMatchObject({ allowed: false });
  });
});
