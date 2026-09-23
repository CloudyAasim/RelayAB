/**
 * GET /v1/models authentication surface.
 *
 * This endpoint must require a valid key. An unauthenticated model catalogue
 * leaked the whole provider mapping to anonymous visitors on one deployment,
 * so these tests pin the contract: no key → 401, wrong key → 401, valid key →
 * 200 with only that key's allowed models.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { GET } from "@/app/api/v1/models/route";

function request(authorization?: string): Request {
  return new Request("http://localhost:3000/v1/models", {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

async function seed(): Promise<{ key: string; restrictedKey: string }> {
  await createProvider({
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "model-a": "upstream-a", "model-b": "upstream-b" },
  });

  const open = await createUser({
    username: "models-open-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const openKey = await createApiKey({ userId: open.id, label: "open" });

  const narrow = await createUser({
    username: "models-narrow-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: ["model-a"],
  });
  // The whitelist lives on the key, not the user.
  const narrowKey = await createApiKey({
    userId: narrow.id,
    label: "narrow",
    allowedModels: ["model-a"],
  });

  return { key: openKey.plainKey, restrictedKey: narrowKey.plainKey };
}

describe("GET /v1/models", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("rejects a request with no Authorization header", async () => {
    await seed();
    const res = await GET(request());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeTruthy();
  });

  it("rejects an unknown key", async () => {
    await seed();
    const res = await GET(request("Bearer sk-relay-0000000000000000000000000000000000000000000"));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    await seed();
    const res = await GET(request("Basic dXNlcjpwYXNz"));
    expect(res.status).toBe(401);
  });

  it("returns the catalogue for a valid key", async () => {
    const { key } = await seed();
    const res = await GET(request(`Bearer ${key}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
  });

  it("only lists models the key's owner is allowed to call", async () => {
    const { restrictedKey } = await seed();
    const res = await GET(request(`Bearer ${restrictedKey}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual(["model-a"]);
  });
});
