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
 *  7. A user's own assistant key is reused for the gateway only when their
 *     assistant really points at this deployment - and never leaked into a
 *     tool result.
 *  8. An unconfigured account cannot start a turn at all, and turns are
 *     rate-limited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { createProvider } from "@/lib/db/providers";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { __resetConfigForTest } from "@/lib/config";
import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import { runChat, type ChatEvent } from "@/lib/assistant/chat";
import { resolveToolCredential } from "@/lib/assistant/credentials";
import {
  createAssistantCredential,
  getAssistantCredential,
  removeAssistantCredential,
  rotateAssistantCredential,
  setAssistantCredentialEnabled,
} from "@/lib/db/assistant-keys";
import { createApiKey, getApiKeyById, listAllApiKeys, listApiKeysByUser } from "@/lib/db/keys";
import { createMediaProvider } from "@/lib/db/media-providers";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";
import { getAssistantSettings, saveAssistantSettings, AssistantSettingsError } from "@/lib/db/assistant";
import { listAssistantThreads } from "@/lib/db/assistant";
import { createAssistantThread } from "@/lib/db/assistant";
import {
  consumeAssistantTurn,
  __resetAssistantRateLimitForTest,
  ASSISTANT_MAX_TURNS_PER_USER,
  ASSISTANT_MAX_TURNS_TOTAL,
} from "@/lib/assistant/rate-limit";
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

describe("assistant: media tools", () => {
  const user = { id: "u-media", username: "media", role: "user" as const, timezone: "shanghai" as const };

  it("refuses to call a media endpoint without the caller's gateway key", async () => {
    __resetDbForTest();
    for (const name of ["generate_image", "generate_speech", "generate_video"]) {
      const result = await executeTool(
        name,
        JSON.stringify({ model: "image-01", prompt: "a cat", input: "hello" }),
        { user },
      );
      // The tool would have to borrow someone else's key to work here, which
      // would quietly bill the wrong account.
      expect(result.ok).toBe(false);
      expect(result.content).toContain("网关密钥");
    }
  });

  it("are offered to regular users, not just admins", () => {
    const names = toolDefinitions(false).map((t) => t.function.name);
    expect(names).toContain("generate_image");
    expect(names).toContain("generate_speech");
    expect(names).toContain("generate_video");
  });

  it("go out through the public route, so a tool result proves the route works", async () => {
    __resetDbForTest();
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();

    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await executeTool(
      "generate_image",
      JSON.stringify({ model: "image-01", prompt: "a red apple" }),
      { user, relayKey: "sk-relay-x" },
    );

    expect(seen[0]?.url).toBe("https://relay.example.com/v1/images/generations");
    expect(seen[0]?.auth).toBe("Bearer sk-relay-x");
    expect((seen[0]?.body as { prompt?: string })?.prompt).toBe("a red apple");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("https://cdn.example/a.png");

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });

  it("does not leak the key into a tool result", async () => {
    __resetDbForTest();
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));

    const result = await executeTool(
      "generate_image",
      JSON.stringify({ model: "image-01", prompt: "x" }),
      { user, relayKey: "sk-relay-secret-value" },
    );
    expect(result.content).not.toContain("sk-relay-secret-value");

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });
  it("supplies the values the vendor requires when the model omits them", async () => {
    // Observed live: the model left `voice` out because the schema called it
    // optional, the upstream answered "missing required parameter
    // voice_setting.voice_id", and the model then told the user the spec was
    // returning the wrong format — which it had no way of knowing.
    __resetDbForTest();
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();

    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response(JSON.stringify({ data: { audio: "x", status: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // No `voice`, no `duration`, no `ratio` in the arguments at all.
    await executeTool("generate_speech", JSON.stringify({ model: "speech-2.8-hd", input: "hi" }), {
      user,
      relayKey: "sk-relay-x",
    });
    expect(seen[0]?.url).toContain("/v1/audio/speech");
    expect(seen[0]?.body.voice).toBe("English_Trustworth_Man");

    await executeTool("generate_video", JSON.stringify({ model: "minimax-h3", prompt: "a cat" }), {
      user,
      relayKey: "sk-relay-x",
    });
    expect(seen[1]?.url).toContain("/v1/videos/generations");
    expect(seen[1]?.body.duration).toBe(6);
    expect(seen[1]?.body.ratio).toBe("16:9");

    // An explicit value still wins.
    await executeTool(
      "generate_speech",
      JSON.stringify({ model: "speech-2.8-hd", input: "hi", voice: "custom-voice" }),
      { user, relayKey: "sk-relay-x" },
    );
    expect(seen[2]?.body.voice).toBe("custom-voice");

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });

  it("tells the model to quote a 400 rather than invent a reason", async () => {
    __resetDbForTest();
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();
    vi.stubGlobal("fetch", async () =>
      new Response("invalid params, missing required parameter (2013)", {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await executeTool(
      "generate_image",
      JSON.stringify({ model: "image-01", prompt: "x" }),
      { user, relayKey: "sk-relay-x" },
    );
    // Without this the model told the user the spec was returning the wrong
    // shape, which it could not know.
    expect(result.content).toContain("不要猜测原因");
    expect(result.content).toContain("missing required parameter");

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });

  it("recognises a 402 as a quota ceiling, not a permission problem", async () => {
    __resetDbForTest();
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();
    vi.stubGlobal("fetch", async () =>
      new Response("upstream_credit_exhausted", { status: 402, headers: { "content-type": "application/json" } }),
    );

    const result = await executeTool(
      "generate_video",
      JSON.stringify({ model: "minimax-h3", prompt: "a cat" }),
      { user, relayKey: "sk-relay-x" },
    );
    expect(result.content).toContain("不是权限问题");

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });
});

describe("assistant: one-shot model probe", () => {
  it("reaches the gateway at its public URL, not localhost", async () => {
    // Regression: the tool used to resolve the gateway host from the
    // `settings.publicUrl` row, which is null on most deployments, so it fell
    // back to http://localhost:3000 and every call from inside the container
    // died with "fetch failed". The canonical resolver is `getPublicUrl()`.
    __resetDbForTest();
    const user = await makeUser("user", "u7");
    const previous = process.env.RELAY_PUBLIC_URL;
    process.env.RELAY_PUBLIC_URL = "https://relay.example.com";
    __resetConfigForTest();

    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await executeTool(
      "test_gateway_model",
      JSON.stringify({ model: "m1", prompt: "hi" }),
      {
        user: { id: user.id, username: user.username, role: user.role, timezone: "shanghai" },
        relayKey: "sk-relay-test",
      },
    );

    expect(seen[0]).toBe("https://relay.example.com/v1/chat/completions");
    expect(result.ok).toBe(true);

    vi.unstubAllGlobals();
    __resetConfigForTest();
    if (previous === undefined) delete process.env.RELAY_PUBLIC_URL;
    else process.env.RELAY_PUBLIC_URL = previous;
  });
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

/**
 * The money question: an account with no assistant settings of its own must not
 * be able to start a turn. This is the path that decides whether the deployment
 * can be made to pay for somebody else's conversation, so it is pinned here
 * rather than left to the route reading correctly.
 */
describe("assistant: an unconfigured account cannot start a turn", () => {
  beforeEach(() => {
    __resetDbForTest();
    __resetAssistantRateLimitForTest();
  });

  function chatRequest(message: unknown): Request {
    return new Request("http://localhost/api/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    });
  }

  it("is refused, and nothing is spent", async () => {
    const user = await makeUser("user", "u7");
    const dialled: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      dialled.push(String(url));
      return new Response("{}", { status: 200 });
    });

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user.id, user.username, "user");
    const { POST } = await import("@/app/api/assistant/chat/route");
    const res = await POST(chatRequest("你好"));
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("not_configured");
    expect(body.error?.message).toMatch(/自己的/);

    // The three things that would have cost something: an upstream call, a
    // conversation row, and a message row.
    expect(dialled).toEqual([]);
    expect(await listAssistantThreads(user.id)).toEqual([]);
    expect(await getAssistantSettings(user.id)).toBeNull();

    vi.unstubAllGlobals();
  });

  it("refuses before the message is even looked at, so the two cannot be confused", async () => {
    // Order matters for a different reason: the rate limiter has to sit ahead
    // of the settings lookup, or an unconfigured account could still be made
    // to do work by simply asking often enough.
    const user = await makeUser("user", "u8");
    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user.id, user.username, "user");
    const { POST } = await import("@/app/api/assistant/chat/route");

    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) {
      expect((await POST(chatRequest("你好"))).status).toBe(409);
    }
    expect((await POST(chatRequest("你好"))).status).toBe(429);
  });

  it("a configured account is unaffected by another account running out", async () => {
    const noisy = await makeUser("user", "u9");
    const quiet = await makeUser("user", "u10");

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, noisy.id, noisy.username, "user");
    const { POST } = await import("@/app/api/assistant/chat/route");
    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) {
      await POST(chatRequest("你好"));
    }
    expect((await POST(chatRequest("你好"))).status).toBe(429);

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, quiet.id, quiet.username, "user");
    expect((await POST(chatRequest("你好"))).status).toBe(409);
  });
});

describe("assistant: what the tools are allowed to spend", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("has nothing to spend until the user creates a credential", async () => {
    const user = await makeUser("user", "u11");
    const resolved = await resolveToolCredential({ userId: user.id });
    expect(resolved).toEqual({ kind: "none", reason: "no_credential" });
  });

  it("still has nothing after a credential is created but not switched on", async () => {
    // The default is off, and "created" is not consent.
    const user = await makeUser("user", "u12");
    const created = await createAssistantCredential(user.id);
    expect(created.enabled).toBe(false);
    expect(await resolveToolCredential({ userId: user.id })).toEqual({
      kind: "none",
      reason: "switch_off",
    });
  });

  it("spends the account once the user switches it on", async () => {
    const user = await makeUser("user", "u13");
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const resolved = await resolveToolCredential({ userId: user.id });
    expect(resolved.kind).toBe("account");
    if (resolved.kind !== "account") throw new Error("unreachable");
    expect(resolved.account.apiKey.userId).toBe(user.id);
    expect(resolved.account.user.id).toBe(user.id);
    // The account it spends is the caller's own, never a neighbour's.
    expect(resolved.account.user.role).toBe("user");
  });

  it("stops spending the moment it is switched back off", async () => {
    const user = await makeUser("user", "u14");
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);
    expect((await resolveToolCredential({ userId: user.id })).kind).toBe("account");

    await setAssistantCredentialEnabled(user.id, false);
    expect((await resolveToolCredential({ userId: user.id })).kind).toBe("none");
  });

  it("never hands out a credential that belongs to somebody else", async () => {
    const owner = await makeUser("user", "u15");
    const other = await makeUser("user", "u16");
    await createAssistantCredential(owner.id);
    await setAssistantCredentialEnabled(owner.id, true);

    const resolved = await resolveToolCredential({ userId: other.id });
    expect(resolved.kind).toBe("none");
  });

  it("a pasted key wins over the account credential", async () => {
    // A deliberate per-request choice is never quietly overridden.
    const user = await makeUser("user", "u17");
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const resolved = await resolveToolCredential({ userId: user.id, relayKey: "  sk-pasted  " });
    expect(resolved).toEqual({ kind: "key", relayKey: "sk-pasted" });
  });

  it("asking for the key path without supplying one does not fall back", async () => {
    // This is the case the old inference got wrong: the user chose a mode, and
    // that choice has to be honoured even when it means "cannot".
    const user = await makeUser("user", "u18");
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const resolved = await resolveToolCredential({ userId: user.id, mode: "key" });
    expect(resolved).toEqual({ kind: "none", reason: "no_credential" });
  });

  it("holds at most one credential per account, however often create is called", async () => {
    const user = await makeUser("user", "u19");
    const first = await createAssistantCredential(user.id);
    const second = await createAssistantCredential(user.id);
    expect(second.apiKeyId).toBe(first.apiKeyId);
  });

  it("rotating produces a different key, and keeps the switch where it was", async () => {
    const user = await makeUser("user", "u20");
    const first = await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const rotated = await rotateAssistantCredential(user.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.apiKeyId).not.toBe(first.apiKeyId);
    expect(rotated!.enabled).toBe(true);
    expect(await getApiKeyById(first.apiKeyId)).toBeNull();
  });

  it("removing takes the underlying key with it", async () => {
    const user = await makeUser("user", "u21");
    const created = await createAssistantCredential(user.id);
    expect(await removeAssistantCredential(user.id)).toBe(true);
    expect(await getApiKeyById(created.apiKeyId)).toBeNull();
    expect(await getAssistantCredential(user.id)).toBeNull();
  });

  it("keeps the credential out of the user's own key list, and off their budget", async () => {
    // maxActiveKeys is computed from that same list, so hiding it here is what
    // stops the assistant from eating a capped user's allowance.
    const user = await makeUser("user", "u22");
    const credential = await createAssistantCredential(user.id);
    const { key } = await createApiKey({ userId: user.id, label: "mine" });

    const { keys } = await listApiKeysByUser(user.id);
    const ids = keys.map((k) => k.id);
    expect(ids).toContain(key.id);
    expect(ids).not.toContain(credential.apiKeyId);
  });

  it("still shows the credential to an admin, so it can be revoked", async () => {
    const user = await makeUser("user", "u23");
    const credential = await createAssistantCredential(user.id);
    const all = await listAllApiKeys({ limit: 200 });
    expect(all.map((k) => k.id)).toContain(credential.apiKeyId);
  });
});

/**
 * The route the panel actually talks to. The verbs are the user's — create,
 * switch on, switch off, rebuild, remove — so each one is pinned here rather
 * than only through the repository.
 */
describe("assistant: /api/assistant/credentials", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  async function asCaller(username: string): Promise<string> {
    const user = await makeUser("user", username);
    const store = new InMemoryCookieStore();
    await loginAs(store, user.id, user.username, "user");
    currentStore = store;
    return user.id;
  }

  function post(action: string): Request {
    return new Request("http://localhost/api/assistant/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
  }

  it("starts out not created, and needs a session", async () => {
    currentStore = new InMemoryCookieStore();
    const { GET } = await import("@/app/api/assistant/credentials/route");
    expect((await GET()).status).toBe(401);

    await asCaller("u40");
    const res = await GET();
    const body = (await res.json()) as { data: { created: boolean; enabled: boolean } };
    expect(body.data).toMatchObject({ created: false, enabled: false, usable: false });
  });

  it("create, enable, disable, rotate, remove", async () => {
    const userId = await asCaller("u41");
    const { GET, POST } = await import("@/app/api/assistant/credentials/route");

    // Enabling before creating is refused rather than silently succeeding.
    expect((await POST(post("enable"))).status).toBe(409);

    const created = await POST(post("create"));
    const createdBody = (await created.json()) as { data: { created: boolean; enabled: boolean; keyPrefix: string } };
    expect(createdBody.data.created).toBe(true);
    // Off by default: creating is not consent.
    expect(createdBody.data.enabled).toBe(false);
    expect(createdBody.data.keyPrefix).toBeTruthy();

    const enabled = (await (await POST(post("enable"))).json()) as { data: { enabled: boolean; usable: boolean } };
    expect(enabled.data).toMatchObject({ enabled: true, usable: true });

    const disabled = (await (await POST(post("disable"))).json()) as { data: { enabled: boolean } };
    expect(disabled.data.enabled).toBe(false);

    const before = await getAssistantCredential(userId);
    const rotated = (await (await POST(post("rotate"))).json()) as { data: { keyPrefix: string } };
    expect(rotated.data.keyPrefix).toBeTruthy();
    expect((await getAssistantCredential(userId))?.apiKeyId).not.toBe(before?.apiKeyId);

    const removed = await POST(post("remove"));
    expect(removed.status).toBe(200);
    expect(await getAssistantCredential(userId)).toBeNull();
    // Removing twice is a clean 404, not a second write.
    expect((await POST(post("remove"))).status).toBe(404);
  });

  it("never returns anything the caller could authenticate with", async () => {
    const userId = await asCaller("u42");
    const { GET, POST } = await import("@/app/api/assistant/credentials/route");
    await POST(post("create"));
    const credential = await getAssistantCredential(userId);

    for (const res of [await GET(), await POST(post("enable"))]) {
      const body = await res.text();
      // The hash is the only value that identifies the row, and the prefix is
      // all the user is ever entitled to see — it is already in their own key
      // list for any normal key.
      expect(body).not.toContain(credential!.key.keyHash);
      expect(body).not.toMatch(/sk-relay-[A-Za-z0-9]{10,}/);
    }
    expect(JSON.stringify(credential)).not.toContain("encrypted");
  });

  it("rejects an unknown action", async () => {
    await asCaller("u43");
    const { POST } = await import("@/app/api/assistant/credentials/route");
    expect((await POST(post("nonsense"))).status).toBe(400);
  });
});

/**
 * The reported bug, end to end. A user asked for a picture and was told to go
 * and configure something. Under the account path the assistant holds a
 * credential the user created and switched on, and calls the media handler
 * in-process with it: no key is pasted, no bearer token exists, and the spend
 * still lands on that user's own quota.
 */
describe("assistant: a turn spent on the caller's own account", () => {
  beforeEach(() => {
    __resetDbForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** One streamed assistant turn, in the chunk shape the client accumulates. */
  function sseTurn(delta: unknown, finishReason: string | null = "stop"): Response {
    const frame = {
      id: "c1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    const body = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  /** A user with room to spend; the default allocation is zero, and a media
   *  call is refused on quota before it ever reaches an upstream. */
  async function makeSpender(username: string): Promise<User> {
    const name = username.padEnd(3, "x");
    const user = await createUser({
      username: name,
      password: "correct horse battery",
      displayName: name,
      quotaType: "credits",
      quotaLimit: 1_000_000,
    });
    expect(user).not.toBeNull();
    return user!;
  }

  async function seedMediaProvider(): Promise<void> {
    await createMediaProvider({
      name: "MiniMax Image",
      baseUrl: "https://api.minimax.test",
      apiKey: "vendor-key",
      models: { "image-01": { upstreamId: "image-01", pricePerItem: 2, enabled: true } },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });
  }

  /** The model asks for the picture on the first turn and then just talks. */
  function assistantTurns(): Array<[unknown, string | null]> {
    return [
      [
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: {
                name: "generate_image",
                arguments: JSON.stringify({ model: "image-01", prompt: "a cat wearing a hat" }),
              },
            },
          ],
        },
        null,
      ],
      [{ content: "图好了。" }, "stop"],
    ];
  }

  it("generates an image with no key pasted and no bearer token anywhere", async () => {
    const user = await makeSpender("u30");
    const owner = { id: user.id, username: user.username, role: user.role, timezone: "shanghai" } as const;
    await saveAssistantSettings(user.id, {
      baseUrl: "https://assistant-upstream.test/v1",
      apiKey: "sk-upstream-key",
      model: "m1",
    });
    const settings = (await getAssistantSettings(user.id))!;
    const thread = await createAssistantThread(user.id, "t");
    await seedMediaProvider();

    const credential = await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const upstream: Array<{ url: string; auth: string | null }> = [];
    const everyUrl: string[] = [];
    const turns = assistantTurns();
    let turn = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      everyUrl.push(target);
      if (target.includes("api.minimax.test")) {
        upstream.push({ url: target, auth: new Headers(init?.headers).get("authorization") });
        return new Response(
          JSON.stringify({
            id: "task-1",
            data: { image_urls: ["https://cdn.example/cat.png"] },
            metadata: { success_count: 1, failed_count: 0 },
            base_resp: { status_code: 0, status_msg: "success" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const next = turns[turn++] ?? turns[turns.length - 1];
      return sseTurn(next[0], next[1]);
    });

    const resolved = await resolveToolCredential({ userId: user.id });
    expect(resolved.kind).toBe("account");

    const events: ChatEvent[] = [];
    await runChat({
      user: owner,
      settings,
      thread,
      message: "用 generate_image 生成一张「戴帽子的猫」",
      credential: resolved,
      gatewayBase: "https://relay.example.com",
      emit: (e) => events.push(e),
    });

    // The tool result is fed back to the model and persisted, not streamed —
    // so the transcript is where the evidence is. Joined from the message
    // *contents* rather than stringified whole: re-stringifying the rows would
    // escape the inner quotes and make every quoted assertion a lie.
    const { listAssistantMessages } = await import("@/lib/db/assistant");
    const persisted = (await listAssistantMessages(thread.id))
      .map((m) => `${m.role}:${m.content}`)
      .join("\n");

    // It really called the media upstream...
    expect(upstream).toHaveLength(1);
    // ...using the provider's own key, because that is what the media layer
    // authenticates with. What matters is that it is NOT one of the user's
    // gateway keys: no bearer token was minted for this call at all.
    expect(upstream[0]?.auth).not.toMatch(/Bearer sk-relay-/);
    expect(persisted).toContain("https://cdn.example/cat.png");
    expect(persisted).toMatch(/"via":\s*"account"/);

    // And nothing in the conversation carries a credential.
    const transcript = persisted;
    expect(transcript).not.toContain("sk-upstream-key");
    expect(transcript).not.toContain("sk-relay-");
    expect(transcript).not.toContain(credential.key.keyHash);

    // The spend landed on the user, not on a neighbour.
    const { listUsageByKey } = await import("@/lib/db/usage");
    const usage = await listUsageByKey(credential.apiKeyId);
    expect(usage).toHaveLength(1);
  });

  it("refuses when the user never switched the credential on", async () => {
    // The same turn, with the switch still off: the tool must decline rather
    // than fall back to anything.
    const user = await makeSpender("u31");
    const owner = { id: user.id, username: user.username, role: user.role, timezone: "shanghai" } as const;
    await saveAssistantSettings(user.id, {
      baseUrl: "https://assistant-upstream.test/v1",
      apiKey: "sk-upstream-key",
      model: "m1",
    });
    const settings = (await getAssistantSettings(user.id))!;
    const thread = await createAssistantThread(user.id, "t");
    await createAssistantCredential(user.id); // created, deliberately not enabled

    const upstream: string[] = [];
    const turns = assistantTurns();
    let turn = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      upstream.push(String(url));
      const next = turns[turn++] ?? turns[turns.length - 1];
      return sseTurn(next[0], next[1]);
    });

    const resolved = await resolveToolCredential({ userId: user.id });
    const events: ChatEvent[] = [];
    await runChat({
      user: owner,
      settings,
      thread,
      message: "用 generate_image 生成一张「戴帽子的猫」",
      credential: resolved,
      gatewayBase: "https://relay.example.com",
      emit: (e) => events.push(e),
    });

    expect(resolved.kind).toBe("none");
    // No media upstream was touched, and the model was told the truth.
    expect(upstream.filter((u) => u.includes("api.minimax.test"))).toEqual([]);
    const { listAssistantMessages } = await import("@/lib/db/assistant");
    const persisted = JSON.stringify(await listAssistantMessages(thread.id));
    expect(persisted).toContain("凭据");
  });
});

describe("assistant: turn rate limit", () => {
  beforeEach(() => {
    __resetAssistantRateLimitForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits the budget and then refuses", () => {
    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) {
      expect(consumeAssistantTurn("u1").limited).toBe(false);
    }
    const refused = consumeAssistantTurn("u1");
    expect(refused.limited).toBe(true);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("counts each account separately", () => {
    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) consumeAssistantTurn("u1");
    expect(consumeAssistantTurn("u1").limited).toBe(true);
    expect(consumeAssistantTurn("u2").limited).toBe(false);
  });

  it("also caps everyone together, because per-account alone does not protect the box", () => {
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 10; j++) {
        if (!consumeAssistantTurn(`u${i}`).limited) admitted++;
      }
    }
    expect(admitted).toBe(ASSISTANT_MAX_TURNS_TOTAL);
  });

  it("does not push the unlock time back when a refused caller keeps hammering", () => {
    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) consumeAssistantTurn("u1");
    const first = consumeAssistantTurn("u1");
    vi.advanceTimersByTime(5_000);
    const later = consumeAssistantTurn("u1");
    expect(later.retryAfterSeconds).toBeLessThanOrEqual(first.retryAfterSeconds);
  });

  it("lets the caller back in once the window rolls over", () => {
    for (let i = 0; i < ASSISTANT_MAX_TURNS_PER_USER; i++) consumeAssistantTurn("u1");
    expect(consumeAssistantTurn("u1").limited).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(consumeAssistantTurn("u1").limited).toBe(false);
  });
});
