/**
 * RB-004: Real-behaviour integration tests for admin PATCH routes.
 *
 * Tests the actual HTTP behaviour of:
 *   PATCH /api/admin/users/[id]   (displayName)
 *   PATCH /api/admin/keys/[id]    (label)
 *
 * Follows the same vi.mock("next/headers") + __setRedisForTest(createMemoryRedis())
 * pattern as admin-user-form-routes.test.ts and admin-provider-patch.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";

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

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis());
  currentStore = null;
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/users/[id]", () => {
  it("(1) admin + valid displayName → 200, getUserById returns the new name", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "NewName" }),
      }),
      { params: Promise.resolve({ id: admin.id }) } as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const updated = await getUserById(admin.id);
    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe("NewName");
  });

  it("(2) admin + pure-whitespace displayName → 400 bad_request, DB unchanged", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin", displayName: "OldName" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "   " }),
      }),
      { params: Promise.resolve({ id: admin.id }) } as any,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");

    const unchanged = await getUserById(admin.id);
    expect(unchanged!.displayName).toBe("OldName");
  });

  it("(3) admin + displayName length 65 → 400 bad_request, DB unchanged", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin", displayName: "OldName" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "a".repeat(65) }),
      }),
      { params: Promise.resolve({ id: admin.id }) } as any,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_request");

    const unchanged = await getUserById(admin.id);
    expect(unchanged!.displayName).toBe("OldName");
  });

  it("(4) admin + displayName exactly 64 chars → 200 (boundary)", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "a".repeat(64) }),
      }),
      { params: Promise.resolve({ id: admin.id }) } as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("(5) admin + displayName with surrounding spaces → 200, trimmed in DB", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "  ZhangSan  " }),
      }),
      { params: Promise.resolve({ id: admin.id }) } as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const updated = await getUserById(admin.id);
    expect(updated!.displayName).toBe("ZhangSan");
  });

  it("(6) non-admin (role=user) → 403, DB unchanged", async () => {
    const victim = await createUser({ username: "victim", password: "pw", displayName: "Victim" });
    const store = new InMemoryCookieStore();
    await loginAs(store, victim.id, "victim", "user"); // non-admin session
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/users/${victim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Hacked" }),
      }),
      { params: Promise.resolve({ id: victim.id }) } as any,
    );

    expect(res.status).toBe(403);
    const unchanged = await getUserById(victim.id);
    expect(unchanged!.displayName).toBe("Victim");
  });

  it("(7) non-existent user id → 404", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/users/[id]/route");

    const res = await PATCH(
      new Request("http://localhost/api/admin/users/nonexistent-id-xyz", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "NewName" }),
      }),
      { params: Promise.resolve({ id: "nonexistent-id-xyz" }) } as any,
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/keys/[id]
// ---------------------------------------------------------------------------

describe("PATCH /api/admin/keys/[id]", () => {
  it("(8) admin + valid label → 200, getApiKeyById returns the new label", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const { key } = await createApiKey({ userId: admin.id, label: "OriginalLabel" });

    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/keys/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "NewLabel" }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const updated = await getApiKeyById(key.id);
    expect(updated!.label).toBe("NewLabel");
  });

  it("(9) admin + empty/blank label → 400 bad_request", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const { key } = await createApiKey({ userId: admin.id, label: "Original" });

    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/keys/[id]/route");

    // Empty string
    let res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "" }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");

    // Whitespace only
    res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "   " }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("(10) admin + label length 65 → 400; length 64 → 200 (boundary)", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const { key } = await createApiKey({ userId: admin.id, label: "Original" });

    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/keys/[id]/route");

    // Too long
    let res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "a".repeat(65) }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");

    // Exactly 64 — boundary
    res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "a".repeat(64) }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("(11) admin + label change — only label may change, all other fields unchanged", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const { key } = await createApiKey({ userId: admin.id, label: "Original" });

    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const before = await getApiKeyById(key.id);
    const snapshot = {
      keyHash: before!.keyHash,
      keyPrefix: before!.keyPrefix,
      userId: before!.userId,
      enabled: before!.enabled,
      forceDisabled: before!.forceDisabled,
      expiresAt: before!.expiresAt,
      createdAt: before!.createdAt,
    };

    const { PATCH } = await import("@/app/api/admin/keys/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "CompletelyNewLabelName" }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );
    expect(res.status).toBe(200);

    const after = await getApiKeyById(key.id);
    expect(after!.label).toBe("CompletelyNewLabelName");
    expect(after!.keyHash).toBe(snapshot.keyHash);
    expect(after!.keyPrefix).toBe(snapshot.keyPrefix);
    expect(after!.userId).toBe(snapshot.userId);
    expect(after!.enabled).toBe(snapshot.enabled);
    expect(after!.forceDisabled).toBe(snapshot.forceDisabled);
    expect(after!.expiresAt).toEqual(snapshot.expiresAt);
    expect(after!.createdAt).toEqual(snapshot.createdAt);
  });

  it("(12) non-admin (role=user) → 403, DB unchanged", async () => {
    const victim = await createUser({ username: "victim", password: "pw", displayName: "Victim" });
    const { key } = await createApiKey({ userId: victim.id, label: "VictimKey" });

    const store = new InMemoryCookieStore();
    await loginAs(store, victim.id, "victim", "user"); // non-admin session
    currentStore = store;

    const { PATCH } = await import("@/app/api/admin/keys/[id]/route");

    const res = await PATCH(
      new Request(`http://localhost/api/admin/keys/${key.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "HackedLabel" }),
      }),
      { params: Promise.resolve({ id: key.id }) } as any,
    );

    expect(res.status).toBe(403);
    const unchanged = await getApiKeyById(key.id);
    expect(unchanged!.label).toBe("VictimKey");
  });
});
