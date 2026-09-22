/**
 * Drives the plain-HTML-form endpoints behind the admin users table
 * ("删除") the way a browser does.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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

function formRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`https://relay.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function readFlashCookie(res: Response): { kind: string; message: string } | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.find((c) => c.startsWith("relay_flash="));
  if (!cookie) return null;
  const value = cookie.slice("relay_flash=".length).split(";")[0];
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

describe("admin user form-POST endpoints", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    currentStore = null;
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
    expect(readFlashCookie(res)).toMatchObject({ kind: "ok" });
  });

  it("delete-form requires an admin session", async () => {
    const user = await createUser({ username: "dave", password: "pw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, user.id, "dave", "user");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/delete-form/route");
    const res = await POST(
      formRequest(`/api/admin/users/${user.id}/delete-form`, {
        userId: user.id,
      }),
    );

    expect(res.status).toBe(303);
    expect(readFlashCookie(res)?.kind).toBe("error");
    expect(await getUserById(user.id)).not.toBeNull();
  });

  it("delete-form refuses to delete own account", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { POST } = await import("@/app/api/admin/users/[id]/delete-form/route");
    const res = await POST(
      formRequest(`/api/admin/users/${admin.id}/delete-form`, {
        userId: admin.id,
      }),
    );

    expect(res.status).toBe(303);
    expect(readFlashCookie(res)?.kind).toBe("error");
    expect(await getUserById(admin.id)).not.toBeNull();
  });
});
