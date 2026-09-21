/**
 * tests/unit/proxy-anthropic.test.ts
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey, getApiKeyById } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";
import type { ApiKey } from "@/lib/db/types";

/**
 * Create an owner plus one key. The proxy needs the owner because the quota
 * pool and the model whitelist live on the user, not the key.
 */
async function setupUserAndKey(): Promise<{
  key: ApiKey;
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
}> {
  const u = await createUser({
    username: "ant-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const result = await createApiKey({ userId: u.id, label: "l" });
  return { key: result.key, user: (await getUserById(u.id))! };
}

async function setupAnthropicProvider(): Promise<string> {
  const p = await createProvider({
    name: "Test Anthropic",
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelMapping: {
      "claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
    },
  });
  return p.id;
}

describe("proxyAnthropicMessage", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("forwards request with x-api-key header", async () => {
    await setupAnthropicProvider();
    const { key, user } = await setupUserAndKey();

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const r = await proxyAnthropicMessage({
      req: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("messages");
    expect((init as RequestInit).headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("returns missing_max_tokens when not provided", async () => {
    const { key, user } = await setupUserAndKey();
    const r = await proxyAnthropicMessage({
      req: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 0,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("missing_max_tokens");
  });

  it("returns model_not_mapped when no Anthropic provider", async () => {
    const { key, user } = await setupUserAndKey();
    // No provider setup
    const r = await proxyAnthropicMessage({
      req: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: vi.fn() as unknown as typeof fetch },
    });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe("model_not_mapped");
  });

  it("records success usage", async () => {
    await setupAnthropicProvider();
    const { key, user } = await setupUserAndKey();

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "x" }],
          model: "claude-3-5-sonnet-20241022",
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await proxyAnthropicMessage({
      req: {
        model: "claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(100);
    expect(logs[0].completionTokens).toBe(50);
    expect(logs[0].upstreamModel).toBe("claude-3-5-sonnet-20241022");

    // Charged to the owner's pool; the key holds no balance of its own.
    const owner = await getUserById(key.userId);
    expect(owner?.quotaUsed).toBeGreaterThan(0);
  });
});
