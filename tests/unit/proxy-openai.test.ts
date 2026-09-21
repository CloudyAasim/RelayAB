/**
 * tests/unit/proxy-openai.test.ts
 *
 * Mocks the upstream fetch with a fake that returns canned responses.
 * Uses the in-memory Redis mock for usage recording.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey, aggregateByKey } from "@/lib/db/usage";
import { generateApiKey, sha256Hex } from "@/lib/crypto/hashing";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import type { ApiKey } from "@/lib/db/types";

/**
 * Create an owner plus one key. Returns both because the proxy needs the
 * owner to resolve the quota pool and the model whitelist.
 */
async function setupUserAndKey(
  over: Partial<ApiKey> = {},
  userOver: { quotaType?: "credits" | "tokens"; quotaLimit?: number; allowedModels?: string[] } = {},
): Promise<{ key: ApiKey; user: Awaited<ReturnType<typeof getUserById>> }> {
  const u = await createUser({
    username: "alice-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: userOver.quotaType ?? "credits",
    quotaLimit: userOver.quotaLimit ?? 1000,
    allowedModels: userOver.allowedModels ?? [],
  });
  const result = await createApiKey({ userId: u.id, label: "l", ...over });
  return { key: result.key, user: await getUserById(u.id) };
}

async function setupProvider(): Promise<string> {
  const p = await createProvider({
    name: "Test OpenAI",
    kind: "openai",
    apiKey: "sk-upstream-test",
    modelMapping: {
      "gpt-4o-mini": "gpt-4o-mini-2024-07-18",
      "gpt-4o": "gpt-4o-2024-08-06",
    },
  });
  return p.id;
}

describe("proxyChatCompletion", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("forwards request and records usage", async () => {
    const providerId = await setupProvider();
    const { key, user } = await setupUserAndKey();

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1695273600,
          model: "gpt-4o-mini-2024-07-18",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hi!" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const r = await proxyChatCompletion({
      req: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("chat/completions");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-upstream-test",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini-2024-07-18"); // mapped
    expect(body.stream).toBe(false);

    // Usage recorded.
    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(10);
    expect(logs[0].completionTokens).toBe(20);
    expect(logs[0].providerId).toBe(providerId);
    // 10 * 15 + 20 * 60 = 1350 / 1000 = 1.35 units → 1 unit (0.001 积分)
    expect(logs[0].creditsUsed).toBe(1);

    // Consumption landed on the OWNER's pool, not on the key.
    const owner = await getUserById(key.userId);
    expect(owner?.quotaUsed).toBe(1);
  });

  it("returns model_not_mapped when no provider supports the model", async () => {
    const { key, user } = await setupUserAndKey();
    const r = await proxyChatCompletion({
      req: { model: "no-such-model", messages: [] },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("model_not_mapped");
  });

  it("returns missing_model when model is empty", async () => {
    const { key, user } = await setupUserAndKey();
    const r = await proxyChatCompletion({
      req: { model: "", messages: [] },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("missing_model");
  });

  it("rejects disabled key", async () => {
    await setupProvider();
    const user = await createUser({ username: "bob-" + Math.random().toString(36).slice(2, 6), password: "x" });
    const result = await createApiKey({ userId: user.id, label: "l" });
    const disabledKey: ApiKey = { ...result.key, enabled: false };
    const owner = await getUserById(user.id);

    const r = await proxyChatCompletion({
      req: { model: "gpt-4o-mini", messages: [] },
      apiKey: disabledKey,
      user: owner!,
      deps: { fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    expect(r.status).toBe(403);
    expect(r.error?.code).toBe("key_disabled");
  });

  it("records an error if upstream returns 500", async () => {
    const providerId = await setupProvider();
    const { key, user } = await setupUserAndKey();

    const fetchMock = vi.fn(async () => new Response("error", { status: 500 }));
    const r = await proxyChatCompletion({
      req: { model: "gpt-4o-mini", messages: [] },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].providerId).toBe(providerId);
  });

  it("accumulates fractional 积分 across requests without rounding up", async () => {
    await setupProvider();
    const { key, user } = await setupUserAndKey({}, { quotaLimit: 100_000 }); // 100 积分

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-2",
          object: "chat.completion",
          created: 1695273600,
          model: "gpt-4o-mini-2024-07-18",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    for (let i = 0; i < 3; i++) {
      const r = await proxyChatCompletion({
        req: { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hi" }] },
        apiKey: key,
      user: user!,
        deps: { fetchImpl: fetchMock as unknown as typeof fetch },
      });
      expect(r.ok).toBe(true);
    }

    const owner = await getUserById(key.userId);
    // 3 × 1.35 units → 3 units total; a whole-积分 ledger would charge 3000.
    expect(owner?.quotaUsed).toBe(3);
    expect(owner?.quotaUsed).toBeLessThan(100);
  });

  it("computes correct quota delta in tokens mode", async () => {
    await setupProvider();
    const user = await createUser({
      username: "tokens-" + Math.random().toString(36).slice(2, 6),
      password: "x",
      quotaType: "tokens",
      quotaLimit: 1_000_000,
    });
    const result = await createApiKey({ userId: user.id, label: "l" });
    const owner = (await getUserById(user.id))!;

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o-mini-2024-07-18",
          choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await proxyChatCompletion({
      req: { model: "gpt-4o-mini", messages: [] },
      apiKey: result.key,
      user: owner,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const fresh = await getUserById(result.key.userId);
    expect(fresh?.quotaUsed).toBe(1500);

    const agg = await aggregateByKey(result.key.id);
    expect(agg.totalTokens).toBe(1500);
  });
});
