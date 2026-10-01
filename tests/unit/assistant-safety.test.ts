/**
 * tests/unit/assistant-safety.test.ts
 *
 * The assistant can propose changes to provider configuration. It must never
 * *make* them. These are the tests that keep that true:
 *
 *  1. A regular user's tool set contains no admin tools, and calling one
 *     server-side is refused even if the model asks for it anyway (the tool
 *     list is a convenience to the model, not the enforcement point).
 *  2. Resolving an action is admin-only.
 *  3. An action resolves exactly once — the status predicate makes a second
 *     click a no-op rather than a second write.
 *  4. The one-shot model probe never persists the key it was handed.
 *  5. Saving settings without a key keeps the stored one.
 *  6. No tool result can carry an encrypted key back to the model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { createProvider } from "@/lib/db/providers";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import { getAssistantSettings, saveAssistantSettings, AssistantSettingsError } from "@/lib/db/assistant";
import {
  createAssistantAction,
  claimAssistantAction,
  getAssistantAction,
  setAssistantActionStatus,
  listAssistantActions,
} from "@/lib/db/assistant";
import { decryptSecret } from "@/lib/crypto/secrets";

async function makeUser(role: "admin" | "user", username: string): Promise<User> {
  // Usernames have a 3-character minimum, so the short ids below are padded
  // here rather than at twelve call sites.
  const name = username.padEnd(3, "x");
  const user = await createUser({ username: name, password: "correct horse battery", displayName: name, role });
  expect(user).not.toBeNull();
  return user!;
}

async function loginAs(store: InMemoryCookieStore, userId: string, username: string, role: "admin" | "user") {
  const s = await getSessionFromStore(store);
  s.userId = userId;
  s.username = username;
  s.role = role;
  await s.save();
}

describe("assistant: tool surface", () => {
  it("hides admin tools from regular users", () => {
    const userTools = toolDefinitions(false).map((t) => t.function.name);
    const adminTools = toolDefinitions(true).map((t) => t.function.name);

    expect(userTools).toContain("list_gateway_models");
    expect(userTools).toContain("test_gateway_model");
    expect(userTools).toContain("get_deployment_notes");

    expect(userTools).not.toContain("list_providers");
    expect(userTools).not.toContain("propose_provider_update");
    expect(userTools).not.toContain("list_users");

    // Admin is a superset, not a different set.
    expect(adminTools).toEqual(expect.arrayContaining(userTools));
  });

  it("refuses an admin tool even when a regular user's model calls one", async () => {
    __resetDbForTest();
    const user = await makeUser("user", "u1");
    // The tool list is a hint to the model. The check below is the real
    // boundary, and it does not consult the list at all.
    const result = await executeTool(
      "list_providers",
      "{}",
      { user: { id: user.id, username: user.username, role: user.role, timezone: "shanghai" } },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("管理员");
  });

  it("refuses a provider proposal from a regular user", async () => {
    __resetDbForTest();
    const user = await makeUser("user", "u2");
    const provider = await createProvider({ name: "P", kind: "openai", apiKey: "sk-x", enabled: true });
    const result = await executeTool(
      "propose_provider_update",
      JSON.stringify({ providerId: provider!.id, summary: "x", baseUrl: "https://evil.example" }),
      { user: { id: user.id, username: user.username, role: user.role, timezone: "shanghai" } },
    );
    expect(result.ok).toBe(false);

    // And nothing was written.
    const after = await getAssistantAction(user.id, "anything");
    expect(after).toBeNull();
    const { listProviders } = await import("@/lib/db/providers");
    const [stillThere] = await listProviders();
    expect(stillThere.baseUrl).toBe(provider!.baseUrl ?? null);
  });

  it("never returns an encrypted key through a tool result", async () => {
    __resetDbForTest();
    const admin = await makeUser("admin", "a1");
    await createProvider({ name: "MiniMax", kind: "openai", apiKey: "sk-super-secret", enabled: true });
    const ctx = { user: { id: admin.id, username: admin.username, role: admin.role, timezone: "shanghai" as const } };

    for (const name of ["list_providers", "list_media_providers", "list_users"]) {
      const res = await executeTool(name, "{}", ctx);
      expect(res.content).not.toContain("sk-super-secret");
      expect(res.content).not.toContain("encryptedApiKey");
      // The whole conversation is persisted and replayed every turn, so a key
      // in one tool result would leak into every future request.
      expect(res.content).not.toMatch(/"[a-f0-9]{64}"/i);
    }
  });
});

describe("assistant: pending actions", () => {
  it("applies at most once, and says so on the second attempt", async () => {
    __resetDbForTest();
    const admin = await makeUser("admin", "a2");
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      summary: "test",
      args: { enabled: false },
      diff: "diff",
    });

    const first = await claimAssistantAction(admin.id, action.id);
    expect(first).not.toBeNull();

    const second = await claimAssistantAction(admin.id, action.id);
    expect(second).toBeNull();
  });

  it("refuses a non-admin at the resolve endpoint", async () => {
    __resetDbForTest();
    const admin = await makeUser("admin", "a3");
    const user = await makeUser("user", "u3");
    const provider = await createProvider({ name: "P", kind: "openai", apiKey: "sk-x", enabled: true });
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider!.id,
      summary: "disable it",
      args: { enabled: false },
      diff: "diff",
    });

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user.id, user.username, "user");
    const { POST } = await import("@/app/api/assistant/actions/[id]/route");
    const res = await POST(
      new Request(`http://localhost/api/assistant/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params: Promise.resolve({ id: action.id }) },
    );
    expect(res.status).toBe(403);

    // The provider is untouched.
    const { getProviderById } = await import("@/lib/db/providers");
    const after = await getProviderById(provider!.id);
    expect(after?.enabled).toBe(true);
  });

  it("applies an approved change and refuses the same action twice", async () => {
    __resetDbForTest();
    const admin = await makeUser("admin", "a4");
    const provider = await createProvider({
      name: "P",
      kind: "openai",
      apiKey: "sk-x",
      baseUrl: "https://old.example/v1",
      enabled: true,
    });
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider!.id,
      summary: "point elsewhere",
      args: { baseUrl: "https://new.example/v1" },
      diff: "diff",
    });

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, admin.id, admin.username, "admin");
    const { POST } = await import("@/app/api/assistant/actions/[id]/route");
    const ctx = { params: Promise.resolve({ id: action.id }) };

    const first = await POST(
      new Request(`http://localhost/api/assistant/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      ctx,
    );
    expect(first.status).toBe(200);

    const { getProviderById } = await import("@/lib/db/providers");
    expect((await getProviderById(provider!.id))?.baseUrl).toBe("https://new.example/v1");

    const second = await POST(
      new Request(`http://localhost/api/assistant/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      ctx,
    );
    expect(second.status).toBe(409);
  });

  it("rejects cleanly without touching the provider", async () => {
    __resetDbForTest();
    const admin = await makeUser("admin", "a5");
    const provider = await createProvider({ name: "P", kind: "openai", apiKey: "sk-x", baseUrl: "https://old.example", enabled: true });
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider!.id,
      summary: "nope",
      args: { baseUrl: "https://bad.example" },
      diff: "diff",
    });

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, admin.id, admin.username, "admin");
    const { POST } = await import("@/app/api/assistant/actions/[id]/route");
    const res = await POST(
      new Request(`http://localhost/api/assistant/actions/${action.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      }),
      { params: Promise.resolve({ id: action.id }) },
    );
    expect(res.status).toBe(200);

    const { getProviderById } = await import("@/lib/db/providers");
    expect((await getProviderById(provider!.id))?.baseUrl).toBe("https://old.example");
    expect((await getAssistantAction(admin.id, action.id))?.status).toBe("rejected");
  });

  it("scopes actions to their owner", async () => {
    __resetDbForTest();
    const a = await makeUser("admin", "a6");
    const b = await makeUser("admin", "a7");
    const action = await createAssistantAction({
      userId: a.id,
      kind: "provider.update",
      summary: "x",
      args: {},
      diff: "d",
    });
    // Another admin must not be able to resolve or even read it.
    expect(await getAssistantAction(b.id, action.id)).toBeNull();
    expect(await listAssistantActions(b.id)).toHaveLength(0);
    expect(await claimAssistantAction(b.id, action.id)).toBeNull();
  });
});

describe("assistant: settings", () => {
  it("keeps the stored key when saving without one", async () => {
    __resetDbForTest();
    const user = await makeUser("user", "u4");
    await saveAssistantSettings(user.id, { baseUrl: "https://a.example/v1", apiKey: "sk-first", model: "m1" });

    await saveAssistantSettings(user.id, { baseUrl: "https://b.example/v1", model: "m2" });

    const after = await getAssistantSettings(user.id);
    expect(after?.baseUrl).toBe("https://b.example/v1");
    expect(after?.model).toBe("m2");
    expect(decryptSecret(after!.encryptedApiKey)).toBe("sk-first");
  });

  it("refuses to save without any key at all", async () => {
    __resetDbForTest();
    const user = await makeUser("user", "u5");
    await expect(
      saveAssistantSettings(user.id, { baseUrl: "https://a.example/v1", model: "m1" }),
    ).rejects.toBeInstanceOf(AssistantSettingsError);
    expect(await getAssistantSettings(user.id)).toBeNull();
  });
});

describe("assistant: one-shot model probe", () => {
  it("does not persist the key it was given", async () => {
    __resetDbForTest();
    const user = await makeUser("user", "u6");
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user.id, user.username, "user");
    const { POST } = await import("@/app/api/models/probe/route");
    const res = await POST(
      new Request("http://localhost/api/models/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://probe.example/v1", apiKey: "sk-ephemeral-secret" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.auth).toBe("Bearer sk-ephemeral-secret");

    // The only durable state is the caller's own assistant settings, and the
    // probe never wrote to it.
    expect(await getAssistantSettings(user.id)).toBeNull();
    vi.unstubAllGlobals();
  });
});
