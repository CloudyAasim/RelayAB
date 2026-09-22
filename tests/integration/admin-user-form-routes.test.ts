/**
 * Drives the plain-HTML-form endpoints behind the admin users table
 * ("停用/启用" and "删除") the way a browser does: an
 * application/x-www-form-urlencoded POST to a URL carrying the user id.
 *
 * Regression guard for two production-only failure modes:
 *
 * 1. The 303 must point at a *relative* path. Built from `req.url` it would
 *    pin the redirect to whatever host the serverless runtime reconstructed;
 *    if that differs from the host the admin browses (custom domain, preview
 *    alias), the session cookie no longer matches and the admin is bounced to
 *    /login — which looks exactly like "the button did nothing".
 * 2. The mutation must actually persist, because the page has no client-side
 *    state to fall back on: the next render is the only feedback.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mock next/headers so the session module works outside a real request ---
let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser, getUserById } from "@/lib/db/users";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

async function loginAs(
  store: InMemoryCookieStore,
  userId: string,
  username: string,
  role: "admin" | "user",
): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = userId;
  s.username = username;
  s.role = role;
  await s.save();
}

/** Exactly what a browser sends for `<form method="POST">`. */
function formRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`https://relay.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("admin user form-POST endpoints", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    currentStore = null;
  });

  it("toggle disables a user and redirects with an origin-relative Location", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const target = await createUser({ username: "alice", password: "pw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/toggle/route");
    const res = await POST(
      formRequest(`/api/admin/users/${target.id}/toggle`, {
        userId: target.id,
        disabled: "true",
      }),
    );

    expect(res.status).toBe(303);
    // Must NOT be absolute: an absolute host can differ from the browsing
    // origin and drop the session cookie on the way back.
    expect(res.headers.get("location")).toBe("/admin/users");

    expect((await getUserById(target.id))?.disabled).toBe(true);
  });

  it("toggle re-enables a disabled user", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const target = await createUser({ username: "bob", password: "pw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/toggle/route");
    await POST(
      formRequest(`/api/admin/users/${target.id}/toggle`, {
        userId: target.id,
        disabled: "true",
      }),
    );
    const res = await POST(
      formRequest(`/api/admin/users/${target.id}/toggle`, {
        userId: target.id,
        disabled: "false",
      }),
    );

    expect(res.status).toBe(303);
    expect((await getUserById(target.id))?.disabled).toBe(false);
  });

  it("refuses to disable the signed-in admin's own account", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/toggle/route");
    const res = await POST(
      formRequest(`/api/admin/users/${admin.id}/toggle`, {
        userId: admin.id,
        disabled: "true",
      }),
    );

    expect(res.status).toBe(400);
    expect((await getUserById(admin.id))?.disabled).toBe(false);
  });

  it("rejects a form whose userId does not match the URL", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const target = await createUser({ username: "carol", password: "pw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/toggle/route");
    const res = await POST(
      formRequest(`/api/admin/users/${target.id}/toggle`, {
        userId: "someone-else",
        disabled: "true",
      }),
    );

    expect(res.status).toBe(400);
    expect((await getUserById(target.id))?.disabled).toBe(false);
  });

  it("requires an admin session", async () => {
    const user = await createUser({ username: "dave", password: "pw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, user.id, "dave", "user");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/toggle/route");
    const res = await POST(
      formRequest(`/api/admin/users/${user.id}/toggle`, {
        userId: user.id,
        disabled: "true",
      }),
    );

    expect(res.status).toBe(403);
    expect((await getUserById(user.id))?.disabled).toBe(false);
  });

  it("delete-form removes the user plus their keys, and redirects relatively", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const target = await createUser({ username: "erin", password: "pw" });
    const { createApiKey, getApiKeyById } = await import("@/lib/db/keys");
    const { key } = await createApiKey({ userId: target.id, label: "erin-key" });

    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/delete-form/route");
    const res = await POST(
      formRequest(`/api/admin/users/${target.id}/delete-form`, {
        userId: target.id,
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/users");
    expect(await getUserById(target.id)).toBeNull();
    expect(await getApiKeyById(key.id)).toBeNull();
  });
});
