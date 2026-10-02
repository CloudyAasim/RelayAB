/**
 * tests/unit/assistant-provider-create.test.ts
 *
 * The assistant can now propose a brand-new provider. There was no tool for it
 * before, because a provider cannot be created without an API key and the
 * approval endpoint carried an explicit invariant: an action never carries a
 * key.
 *
 * The way out was not to weaken that. A create carries everything *except* the
 * key, and the approval supplies it:
 *
 *   - the model has no parameter a key could go in, so it cannot put one in
 *     the stored action even if it tried;
 *   - the key arrives on the approval request, goes straight to the provider
 *     row, and is encrypted on the way in;
 *   - a missing key is refused *before* the claim, so a proposal is never
 *     spent on a field the admin has not filled in yet.
 *
 * These tests walk all three.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { POST } from "@/app/api/assistant/actions/[id]/route";
import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { redactToolCalls, runChat } from "@/lib/assistant/chat";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import {
  getAssistantAction,
  listAssistantActions,
  listAssistantMessages,
  createAssistantThread,
} from "@/lib/db/assistant";
import { listProviders, getProviderById } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

function decide(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`https://api.example/api/assistant/actions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("assistant: proposing a provider that does not exist yet", () => {
  let store: InMemoryCookieStore;
  let admin: User;
  let plain: User;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    admin = (await createUser({
      username: "create-admin",
      password: "correct horse battery",
      displayName: "create-admin",
      role: "admin",
    }))!;
    plain = (await createUser({
      username: "create-user",
      password: "correct horse battery",
      displayName: "create-user",
    }))!;
    await signIn(admin);
  });

  afterEach(() => {
    currentStore = null;
    vi.unstubAllGlobals();
  });

  async function signIn(u: User, s: InMemoryCookieStore = store): Promise<void> {
    const session = await getSessionFromStore(s);
    session.userId = u.id;
    session.username = u.username;
    session.role = u.role;
    await session.save();
  }

  const ctx = (u: User) => ({
    user: { ...u, timezone: "shanghai" as const },
  });

  const SPEC = {
    name: "MiniMax CN",
    baseUrl: "https://api.minimaxi.com/v1",
    summary: "接入 MiniMax 国内区",
    modelMapping: { "minimax-m2": "MiniMax-M2" },
  };

  it("records a create with no key anywhere in it", async () => {
    const result = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    expect(result.ok).toBe(true);
    const actionId = (result.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    expect(actionId).toBeTruthy();

    const action = await getAssistantAction(admin.id, actionId);
    expect(action?.kind).toBe("provider.create");
    // There is no target yet — that is what "create" means.
    expect(action?.targetId).toBeNull();
    // The three places a key could hide, checked rather than assumed.
    expect(action?.args).not.toContain("apiKey");
    expect(action?.diff).not.toMatch(/apiKey["':]\s*sk-/);
    expect(result.content).not.toMatch(/apiKey["':]\s*sk-/);
    expect(result.content).toContain("管理员在界面上补填 API 密钥");
  });

  it("refuses a create that carries a key, whatever the model sends", async () => {
    // `additionalProperties: false` is what stops this, so the model cannot
    // smuggle a secret into the stored action by inventing a field.
    const result = await executeTool(
      "propose_provider_create",
      JSON.stringify({ ...SPEC, apiKey: "sk-smuggled" }),
      ctx(admin) as never,
    );
    expect(result.ok).toBe(false);
    expect(await listAssistantActions(admin.id)).toHaveLength(0);
  });

  it("refuses to apply a create until the admin supplies the key", async () => {
    const proposed = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];

    const res = await decide(actionId, { decision: "approve" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("api_key_required");

    // And the proposal survives: it is still there, still pending, so the
    // admin can fill the field in rather than making the model do it again.
    expect((await getAssistantAction(admin.id, actionId))?.status).toBe("pending");
    expect(await listProviders()).toHaveLength(0);
  });

  it("creates it once the key arrives, and stores the key encrypted", async () => {
    const proposed = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];

    const res = await decide(actionId, { decision: "approve", apiKey: "sk-real-vendor-key" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("applied");

    const created = await listProviders();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "MiniMax CN", baseUrl: "https://api.minimaxi.com/v1" });
    expect(created[0].modelMapping).toEqual({ "minimax-m2": "MiniMax-M2" });

    // The only copy of the key, and it is ciphertext.
    expect(created[0].encryptedApiKey).not.toBe("sk-real-vendor-key");
    expect(decryptSecret(created[0].encryptedApiKey)).toBe("sk-real-vendor-key");
  });

  it("does not put the key where a tool result or an action could leak it", async () => {
    const proposed = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    await decide(actionId, { decision: "approve", apiKey: "sk-real-vendor-key" });

    // The action row is the thing an admin list, a diff view or a log could
    // expose, so the key must not be in it even after the apply succeeded.
    const action = await getAssistantAction(admin.id, actionId);
    expect(JSON.stringify(action)).not.toContain("sk-real-vendor-key");
    expect(action?.result).not.toContain("sk-real-vendor-key");
  });

  it("will not accept a key on an update, where it would be a silent no-op", async () => {
    const { createProvider } = await import("@/lib/db/providers");
    const provider = await createProvider({ name: "Existing", kind: "openai", apiKey: "sk-old" });
    const { createAssistantAction } = await import("@/lib/db/assistant");
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider.id,
      summary: "改个 base URL",
      args: { baseUrl: "https://new.example/v1" },
      diff: "baseUrl: https://old → https://new",
    });

    // Silently ignoring it would read as "the key was changed".
    const res = await decide(action.id, { decision: "approve", apiKey: "sk-sneaky" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unexpected_api_key");
    expect((await getAssistantAction(admin.id, action.id))?.status).toBe("pending");
  });

  it("creates a media provider the same way", async () => {
    const proposed = await executeTool(
      "propose_media_provider_create",
      JSON.stringify({
        name: "MiniMax Media",
        baseUrl: "https://api.minimaxi.com",
        summary: "接图片和语音",
        models: { "image-01": { upstreamId: "image-01", pricePerItem: 2, enabled: true } },
      }),
      ctx(admin) as never,
    );
    expect(proposed.ok).toBe(true);
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    expect((await getAssistantAction(admin.id, actionId))?.kind).toBe("media_provider.create");

    const refused = await decide(actionId, { decision: "approve" });
    expect(refused.status).toBe(400);

    const res = await decide(actionId, { decision: "approve", apiKey: "sk-media-vendor" });
    expect(res.status).toBe(200);
    const created = await listMediaProviders();
    expect(created).toHaveLength(1);
    expect(decryptSecret(created[0].encryptedApiKey)).toBe("sk-media-vendor");
  });

  it("refuses a media create whose models are empty or malformed", async () => {
    const empty = await executeTool(
      "propose_media_provider_create",
      JSON.stringify({ name: "X", summary: "s", models: {} }),
      ctx(admin) as never,
    );
    expect(empty.ok).toBe(false);

    const noUpstream = await executeTool(
      "propose_media_provider_create",
      JSON.stringify({ name: "X", summary: "s", models: { "image-01": { pricePerItem: 1 } } }),
      ctx(admin) as never,
    );
    expect(noUpstream.ok).toBe(false);
    expect(noUpstream.content).toContain("upstreamId");
  });

  it("refuses a create with no usable name", async () => {
    // A provider with a blank name is a row nothing can be picked out of in
    // the admin's list, and it is created the moment the admin approves — so
    // the tool is the only place this can be caught.
    for (const bad of [{ ...SPEC, name: "" }, { ...SPEC, name: "   " }, { summary: "s" }]) {
      const result = await executeTool(
        "propose_provider_create",
        JSON.stringify(bad),
        ctx(admin) as never,
      );
      expect(result.ok, `accepted ${JSON.stringify((bad as { name?: string }).name ?? "(missing)")}`).toBe(false);
      expect(result.content).toContain("缺少 name");
    }
    expect(await listAssistantActions(admin.id)).toHaveLength(0);
  });

  it("is admin-only, at the tool and at the approval", async () => {
    const asUser = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(plain) as never,
    );
    expect(asUser.ok).toBe(false);
    expect(asUser.content).toContain("管理员");

    const other = new InMemoryCookieStore();
    await signIn(plain, other);
    currentStore = other;
    const { createAssistantAction } = await import("@/lib/db/assistant");
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.create",
      summary: "s",
      args: { name: "X" },
      diff: "d",
    });
    const res = await decide(action.id, { decision: "approve", apiKey: "sk-x" });
    expect(res.status).toBe(403);
    expect((await getAssistantAction(admin.id, action.id))?.status).toBe("pending");
  });

  it("still only offers the create to an admin", () => {
    const names = (isAdmin: boolean) => toolDefinitions(isAdmin).map((t) => t.function.name);
    expect(names(true)).toContain("propose_provider_create");
    expect(names(false)).not.toContain("propose_provider_create");
  });

  it("does not leave a second claim able to apply it again", async () => {
    const proposed = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    const first = await decide(actionId, { decision: "approve", apiKey: "sk-once" });
    expect(first.status).toBe(200);
    const second = await decide(actionId, { decision: "approve", apiKey: "sk-twice" });
    expect(second.status).toBe(409);
    // One provider, not two — the claim is what stops it.
    expect(await listProviders()).toHaveLength(1);
  });

  it("leaves an update path that still works, unchanged", async () => {
    const { createProvider } = await import("@/lib/db/providers");
    const provider = await createProvider({ name: "Existing", kind: "openai", apiKey: "sk-old" });
    const { createAssistantAction } = await import("@/lib/db/assistant");
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider.id,
      summary: "改 base URL",
      args: { baseUrl: "https://new.example/v1" },
      diff: "d",
    });
    const res = await decide(action.id, { decision: "approve" });
    expect(res.status).toBe(200);
    expect((await getProviderById(provider.id))?.baseUrl).toBe("https://new.example/v1");
  });

  it("keeps the ciphertext out of anything the reader can see", async () => {
    // A belt-and-braces check: the fixture key must not survive anywhere in
    // the action list an admin's panel reads.
    const proposed = await executeTool(
      "propose_provider_create",
      JSON.stringify(SPEC),
      ctx(admin) as never,
    );
    const actionId = (proposed.content.match(/"actionId":\s*"([^"]+)"/) ?? [])[1];
    await decide(actionId, { decision: "approve", apiKey: "sk-very-secret-vendor-key" });
    const listed = await listAssistantActions(admin.id);
    const body = JSON.stringify(listed);
    expect(body).not.toContain("sk-very-secret-vendor-key");
    expect(body).not.toContain(encryptSecret("sk-very-secret-vendor-key"));
  });
});

describe("the second line of defence, for a model that ignores the first", () => {
  it("scrubs a key-shaped argument before the tool call is stored", () => {
    // The tools refuse an `apiKey` field, but the model's tool call is written
    // to the database verbatim — and that row is replayed on every later turn.
    // So the redaction happens on the way in regardless of what the model did.
    const [redacted] = redactToolCalls([
      {
        id: "call_1",
        type: "function",
        function: {
          name: "propose_provider_create",
          arguments: JSON.stringify({ name: "X", apiKey: "sk-leaked" }),
        },
      },
    ]);
    expect(redacted.function.arguments).not.toContain("sk-leaked");
    expect(redacted.function.arguments).toContain('"name":"X"');
    expect(redacted.function.arguments).toContain("***");
  });

  it("scrubs every spelling of the field, and leaves the rest alone", () => {
    const [out] = redactToolCalls([
      {
        id: "c",
        type: "function",
        function: {
          name: "t",
          arguments:
            '{"api_key":"a","API_KEY":"b","token":"c","password":"d","prompt":"keep me","summary":"also me"}',
        },
      },
    ]);
    for (const secret of ["\"a\"", "\"b\"", "\"c\"", "\"d\""]) {
      expect(out.function.arguments).not.toContain(secret);
    }
    expect(out.function.arguments).toContain("keep me");
    expect(out.function.arguments).toContain("also me");
  });

  it("leaves a call that has no secret exactly as it was", () => {
    // Redaction that rewrites ordinary calls would be its own bug: the
    // protocol has to replay byte for byte.
    const args = JSON.stringify({ name: "X", baseUrl: "https://a.example/v1" });
    const [out] = redactToolCalls([{ id: "c", type: "function", function: { name: "t", arguments: args } }]);
    expect(out.function.arguments).toBe(args);
  });

  it("is what the persist path actually uses, not just a helper that exists", async () => {    // The three tests above prove the function. This one proves the turn loop
    // calls it — which it did not, the first time this was written, and no
    // earlier test would have noticed.
    const db = await import("@/lib/db/sqlite");
    db.__resetDbForTest();
    const caller = (await createUser({
      username: "leak-user",
      password: "correct horse battery",
      displayName: "leak-user",
    }))!;
    const thread = await createAssistantThread(caller.id, "add a provider");

    // A model that ignored the instruction and passed a key anyway.
    const leaked = vi.fn().mockImplementation(async () => {
      const frame = {
        id: "c1",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "propose_provider_create",
                    arguments: '{"name":"X","apiKey":"sk-leaked-into-the-transcript"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      const body = `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", leaked);

    await runChat({
      user: { ...caller, timezone: "shanghai" as const } as never,
      settings: {
        userId: caller.id,
        baseUrl: "https://upstream.example/v1",
        model: "m",
        encryptedApiKey: encryptSecret("sk-upstream"),
        protocol: "openai",
        extraHeaders: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      thread,
      message: "加个服务商",
      credential: { kind: "none", reason: "not_configured" } as never,
      emit: () => {},
    });

    const rows = await listAssistantMessages(thread.id);
    const assistant = rows.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls).toHaveLength(1);
    // The row that is replayed on every later turn does not hold the key.
    expect(JSON.stringify(rows)).not.toContain("sk-leaked-into-the-transcript");
    expect(assistant?.toolCalls[0].function.arguments).toContain('"name":"X"');
  });
});
