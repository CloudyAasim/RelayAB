/**
 * PATCH /api/admin/providers/:id — what the edit modal saves.
 *
 * Regression context: the edit modal could not set a model's context window,
 * output cap or credit cost. Two things were missing: the modal never sent
 * `modelConfigs`, and `PatchSchema` did not accept the field, so even a hand
 * crafted request would have been silently stripped.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser } from "@/lib/db/users";
import { createProvider, getProviderById } from "@/lib/db/providers";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { PATCH } from "@/app/api/admin/providers/[id]/route";

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

function patchRequest(id: string, body: unknown): Request {
  return new Request(`https://relay.example.com/api/admin/providers/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("PATCH /api/admin/providers/:id", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    currentStore = null;
  });

  it("persists modelMapping together with the per-model config", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const provider = await createProvider({
      name: "P",
      kind: "openai",
      baseUrl: "https://up.test/v1",
      apiKey: "sk-up",
      enabled: true,
      upstreamFormat: "chat",
      modelMapping: {},
    });

    const res = await PATCH(
      patchRequest(provider.id, {
        modelMapping: { "gpt-4o": "gpt-4o-2024-08-06" },
        modelConfigs: {
          "gpt-4o": {
            clientId: "gpt-4o",
            upstreamId: "gpt-4o-2024-08-06",
            contextLength: 200000,
            maxOutputTokens: 16384,
            inputCost: 12,
            outputCost: 34,
            enabled: true,
          },
        },
      }),
      ctx(provider.id),
    );

    expect(res.status).toBe(200);
    const stored = await getProviderById(provider.id);
    expect(stored?.modelMapping).toEqual({ "gpt-4o": "gpt-4o-2024-08-06" });
    expect(stored?.modelConfigs?.["gpt-4o"]).toMatchObject({
      contextLength: 200000,
      maxOutputTokens: 16384,
      inputCost: 12,
      outputCost: 34,
    });
  });

  it("rejects a config the schema does not allow", async () => {
    const admin = await createUser({ username: "admin", password: "pw", role: "admin" });
    const store = new InMemoryCookieStore();
    await loginAs(store, admin.id, "admin", "admin");
    currentStore = store;

    const provider = await createProvider({
      name: "P",
      kind: "openai",
      apiKey: "sk-up",
      modelMapping: {},
    });

    const res = await PATCH(
      patchRequest(provider.id, {
        modelConfigs: { m: { clientId: "m", upstreamId: "u", contextLength: 0 } },
      }),
      ctx(provider.id),
    );
    expect(res.status).toBe(400);
  });

  it("requires an admin session", async () => {
    currentStore = new InMemoryCookieStore();
    const provider = await createProvider({
      name: "P",
      kind: "openai",
      apiKey: "sk-up",
      modelMapping: {},
    });
    const res = await PATCH(patchRequest(provider.id, { name: "x" }), ctx(provider.id));
    expect(res.status).toBe(403);
  });
});
