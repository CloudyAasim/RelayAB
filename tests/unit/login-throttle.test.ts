import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest } from "@/lib/db/redis";
import {
  checkLoginThrottle,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_THROTTLE_MAX_PER_USER,
  LOGIN_THROTTLE_MAX_PER_IP,
  LOGIN_THROTTLE_WINDOW_SECONDS,
} from "@/lib/auth/login-throttle";

function headersFor(ip: string): Headers {
  const h = new Headers();
  // Mimic a platform proxy: client first, then the edge hop.
  h.set("x-forwarded-for", `${ip}, 10.0.0.1`);
  return h;
}

describe("login throttle", () => {
  beforeEach(() => {
    __resetRedisForTest();
  });

  it("allows attempts below the per-username budget", async () => {
    const h = headersFor("203.0.113.10");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_USER - 1; i++) {
      await recordLoginFailure(h, "admin");
    }
    const state = await checkLoginThrottle(h, "admin");
    expect(state.limited).toBe(false);
  });

  it("blocks the username once its budget is exhausted", async () => {
    const h = headersFor("203.0.113.11");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_USER; i++) {
      await recordLoginFailure(h, "admin");
    }
    const state = await checkLoginThrottle(h, "admin");
    expect(state.limited).toBe(true);
    expect(state.retryAfterSeconds).toBe(LOGIN_THROTTLE_WINDOW_SECONDS);
  });

  it("does not blame a different username on the same IP", async () => {
    const h = headersFor("203.0.113.12");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_USER; i++) {
      await recordLoginFailure(h, "admin");
    }
    expect((await checkLoginThrottle(h, "admin")).limited).toBe(true);
    // Same IP, different account — the per-IP budget is separate and higher.
    expect((await checkLoginThrottle(h, "alice")).limited).toBe(false);
  });

  it("blocks an IP that sprays many usernames", async () => {
    const h = headersFor("203.0.113.99");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_IP; i++) {
      await recordLoginFailure(h, `user-${i}`);
    }
    expect((await checkLoginThrottle(h, "admin")).limited).toBe(true);
  });

  it("clears both budgets after a successful login", async () => {
    const h = headersFor("203.0.113.13");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_USER; i++) {
      await recordLoginFailure(h, "admin");
    }
    await clearLoginFailures(h, "admin");
    expect((await checkLoginThrottle(h, "admin")).limited).toBe(false);
  });

  it("treats the username case-insensitively", async () => {
    const h = headersFor("203.0.113.14");
    for (let i = 0; i < LOGIN_THROTTLE_MAX_PER_USER; i++) {
      await recordLoginFailure(h, "Admin");
    }
    expect((await checkLoginThrottle(h, "admin")).limited).toBe(true);
  });
});
