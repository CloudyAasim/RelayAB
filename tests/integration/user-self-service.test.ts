/**
 * tests/integration/user-self-service.test.ts
 *
 * Validates the new self-service flows end-to-end. Mocks `next/headers`'s
 * `cookies()` so we can drive the route handlers from a unit test
 * without binding a server. The session is injected via a shared
 * InMemoryCookieStore that the mocked `cookies()` returns.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Mock next/headers so the session module works outside a real request ---
// Each test sets `currentStore` to the cookie store that should be returned
// from cookies() — same object the test uses to log the user in.
let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";
import { getPublicUrl } from "@/lib/config";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

async function loginAs(store: InMemoryCookieStore, userId: string, username: string, role: "admin" | "user"): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = userId;
  s.username = username;
  s.role = role;
  await s.save();
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://localhost/fake", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function asJson(res: Response): Promise<{ status: number; body: any }> {
  const status = res.status;
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status, body };
}

describe("change-password endpoint", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("requires a session", async () => {
    currentStore = new InMemoryCookieStore(); // empty
    const req = jsonRequest("POST", {
      currentPassword: "x",
      newPassword: "longenough",
      confirmPassword: "longenough",
    });
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
  });

  it("rejects mismatched new passwords", async () => {
    const u = await createUser({ username: "alice", password: "longenoughpw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "alice", "user");
    currentStore = store;

    const req = jsonRequest("POST", {
      currentPassword: "longenoughpw",
      newPassword: "newpw1234",
      confirmPassword: "DIFFERENT",
    });
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(400);
    expect(body.error?.code).toBe("password_mismatch");
  });

  it("rejects when current password is wrong", async () => {
    const u = await createUser({ username: "bob", password: "longenoughpw" });
    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "bob", "user");
    currentStore = store;

    const req = jsonRequest("POST", {
      currentPassword: "wrongpw",
      newPassword: "newpw1234",
      confirmPassword: "newpw1234",
    });
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(403);
    expect(body.error?.code).toBe("wrong_current_password");
  });

  it("successfully changes password when all gates pass", async () => {
    const u = await createUser({ username: "carol", password: "oldpassword" });
    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "carol", "user");
    currentStore = store;

    const req = jsonRequest("POST", {
      currentPassword: "oldpassword",
      newPassword: "newpassword",
      confirmPassword: "newpassword",
    });
    const { POST } = await import("@/app/api/auth/change-password/route");
    const res = await POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const refreshed = await getUserById(u.id);
    expect(refreshed).not.toBeNull();
    const { verifyPassword } = await import("@/lib/crypto/password");
    expect(await verifyPassword("newpassword", refreshed!.passwordHash)).toBe(true);
    expect(await verifyPassword("oldpassword", refreshed!.passwordHash)).toBe(false);
  });
});

describe("user self-service API key endpoints", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("user creates a key; quota stays on the account, not the key", async () => {
    const u = await createUser({
      username: "dave",
      password: "longenoughpw",
      quotaType: "tokens",
      quotaLimit: 100_000,
      allowedModels: ["gpt-4o-mini", "claude-3-5-haiku"],
      maxActiveKeys: 5,
    });
    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "dave", "user");
    currentStore = store;

    const req = jsonRequest("POST", { label: "my-key", expiresAt: null });
    const { POST } = await import("@/app/api/user/keys/route");
    const res = await POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The key is a credential: it inherits no balance of its own.
    expect(body.data.key.quotaLimit).toBeUndefined();
    expect(body.data.key.quotaUsed).toBeUndefined();
    // Per-key scope starts empty; the owner's whitelist still applies.
    expect(body.data.key.allowedModels).toEqual([]);
    expect(body.data.plainKey).toMatch(/^sk-relay-/);
    // The granted pool is what the account now holds.
    const owner = await getUserById(u.id);
    expect(owner?.quotaLimit).toBe(100_000);
    expect(owner?.quotaUsed).toBe(0);
  });

  it("enforces maxActiveKeys cap", async () => {
    const u = await createUser({
      username: "erin",
      password: "longenoughpw",
      maxActiveKeys: 1,
    });
    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "erin", "user");
    currentStore = store;

    // First key: OK.
    let res = await (await import("@/app/api/user/keys/route")).POST(
      jsonRequest("POST", { label: "first" }),
    );
    expect(res.status).toBe(200);

    // Second: rejected.
    res = await (await import("@/app/api/user/keys/route")).POST(
      jsonRequest("POST", { label: "second" }),
    );
    const { status, body } = await asJson(res);
    expect(status).toBe(403);
    expect(body.error?.code).toBe("max_keys_reached");
  });

  it("blocks disabled user", async () => {
    const u = await createUser({ username: "frank", password: "longenoughpw" });
    const { updateUser } = await import("@/lib/db/users");
    await updateUser(u.id, { disabled: true });

    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "frank", "user");
    currentStore = store;

    const req = jsonRequest("POST", { label: "nope" });
    const res = await (await import("@/app/api/user/keys/route")).POST(req);
    const { status, body } = await asJson(res);
    expect(status).toBe(403);
    expect(body.error?.code).toBe("user_disabled");
  });

  it("user cannot update someone else's key", async () => {
    const owner = await createUser({ username: "owner", password: "longenoughpw" });
    const attacker = await createUser({ username: "attacker", password: "longenoughpw" });
    const { key: ownerKey } = await createApiKey({
      userId: owner.id,
      label: "x",
    });

    const store = new InMemoryCookieStore();
    await loginAs(store, attacker.id, "attacker", "user");
    currentStore = store;

    const req = jsonRequest("PATCH", { label: "hijacked" });
    const res = await (await import("@/app/api/user/keys/[id]/route")).PATCH(req, {
      params: Promise.resolve({ id: ownerKey.id }),
    });
    const { status, body } = await asJson(res);
    expect(status).toBe(403);
    expect(body.error?.code).toBe("forbidden");

    const reloaded = await getApiKeyById(ownerKey.id);
    expect(reloaded!.label).toBe("x");
  });

  it("user can rename and toggle their own key", async () => {
    const u = await createUser({ username: "gina", password: "longenoughpw" });
    const { key } = await createApiKey({
      userId: u.id,
      label: "old",
    });

    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "gina", "user");
    currentStore = store;

    const req = jsonRequest("PATCH", { label: "new", enabled: false });
    const res = await (await import("@/app/api/user/keys/[id]/route")).PATCH(req, {
      params: Promise.resolve({ id: key.id }),
    });
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.data.key.label).toBe("new");
    expect(body.data.key.enabled).toBe(false);
  });

  it("user can delete their own key", async () => {
    const u = await createUser({ username: "hugo", password: "longenoughpw" });
    const { key } = await createApiKey({
      userId: u.id,
      label: "to-delete",
    });

    const store = new InMemoryCookieStore();
    await loginAs(store, u.id, "hugo", "user");
    currentStore = store;

    const req = jsonRequest("DELETE");
    const res = await (await import("@/app/api/user/keys/[id]/route")).DELETE(req, {
      params: Promise.resolve({ id: key.id }),
    });
    const { status } = await asJson(res);
    expect(status).toBe(200);
    expect(await getApiKeyById(key.id)).toBeNull();
  });

  it("GET /api/user/keys lists only the current user's keys", async () => {
    const alice = await createUser({ username: "alice2", password: "longenoughpw" });
    const bob = await createUser({ username: "bob2", password: "longenoughpw" });
    await createApiKey({ userId: alice.id, label: "a" });
    await createApiKey({ userId: bob.id, label: "b" });
    await createApiKey({ userId: bob.id, label: "b2" });

    const store = new InMemoryCookieStore();
    await loginAs(store, bob.id, "bob2", "user");
    currentStore = store;

    const res = await (await import("@/app/api/user/keys/route")).GET();
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.data.keys).toHaveLength(2);
    expect(body.data.keys.every((k: any) => k.userId === bob.id)).toBe(true);
  });
});

describe("/api/config public endpoint", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it("returns the configured public URL and the standard endpoints", async () => {
    const { GET } = await import("@/app/api/config/route");
    const res = await GET();
    const { status, body } = await asJson(res);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const base = getPublicUrl();
    expect(body.data.publicUrl).toBe(base);
    expect(body.data.endpoints.openai.baseUrl).toBe(`${base}/v1`);
    expect(body.data.endpoints.anthropic.baseUrl).toBe(`${base}/anthropic`);
    expect(body.data.authScheme).toMatch(/Bearer/);
  });
});
