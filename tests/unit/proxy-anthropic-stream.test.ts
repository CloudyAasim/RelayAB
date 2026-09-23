/**
 * Batch 3: anthropic streaming passthrough tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";
import { listUsageByKey } from "@/lib/db/usage";

async function setup(): Promise<{ key: Awaited<ReturnType<typeof createApiKey>>["key"]; user: NonNullable<Awaited<ReturnType<typeof getUserById>>> }> {
  const u = await createUser({
    username: "streama-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const r = await createApiKey({ userId: u.id, label: "l" });
  await createProvider({
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://upstream.test",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "client-m": "upstream-m" },
  });
  const user = await getUserById(u.id);
  if (!user) throw new Error("setup: user not found");
  return { key: r.key, user };
}

const SSE_WITH_USAGE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"upstream-m","content":[],"stop_reason":null,"usage":{"input_tokens":8,"output_tokens":0}}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  "",
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

describe("Batch 3: anthropic streaming", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("forwards stream:true and bills on the usage frame", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      return new Response(SSE_WITH_USAGE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as ReturnType<typeof vi.fn> & { (...args: unknown[]): Promise<Response> };
    const { key, user } = await setup();
    const result = await proxyAnthropicMessage({
      req: {
        model: "client-m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(result.ok).toBe(true);
    expect(result.body).toBeTruthy();
    const initObj = (fetchMock.mock.calls[0]?.[1] as unknown as RequestInit | undefined);
    const sent = JSON.parse((initObj?.body ?? "{}") as string);
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe("upstream-m");
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);

    if (result.body) {
      const reader = result.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("usage");
    expect(logs[0].promptTokens).toBe(8);
    expect(logs[0].completionTokens).toBe(4);
  });
});
