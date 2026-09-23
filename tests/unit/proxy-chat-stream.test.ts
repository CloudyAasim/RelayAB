/**
 * Batch 3: chat streaming passthrough tests.
 *
 * The proxy must forward `stream: true` to the upstream, capture the final
 * usage frame, and bill accordingly. When the upstream never emits a usage
 * frame, bill by estimate (per project policy).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import { listUsageByKey } from "@/lib/db/usage";

async function setup(): Promise<{ key: Awaited<ReturnType<typeof createApiKey>>["key"]; user: NonNullable<Awaited<ReturnType<typeof getUserById>>> }> {
  const u = await createUser({
    username: "streamc-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const r = await createApiKey({ userId: u.id, label: "l" });
  await createProvider({
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "client-m": "upstream-m" },
  });
  const user = await getUserById(u.id);
  if (!user) throw new Error("setup: user not found");
  return { key: r.key, user };
}

const SSE_WITH_USAGE = [
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  'data: [DONE]',
  "",
].join("\n");

const SSE_NO_USAGE = [
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello world"},"finish_reason":null}]}',
  'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  "",
].join("\n");

describe("Batch 3: chat streaming", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("passes stream:true and stream_options.include_usage to upstream", async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      return new Response(SSE_WITH_USAGE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as ReturnType<typeof vi.fn> & { (...args: unknown[]): Promise<Response> };
    const { key, user } = await setup();
    const result = await proxyChatCompletion({
      req: {
        model: "client-m",
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
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.model).toBe("upstream-m");
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    // Drain the stream so flush() runs.
    if (result.body) {
      const reader = result.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    // Usage should be recorded with billingMode="usage".
    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("usage");
    expect(logs[0].promptTokens).toBe(10);
    expect(logs[0].completionTokens).toBe(5);
  });

  it("estimates tokens when no usage frame arrives", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(SSE_NO_USAGE, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const { key, user } = await setup();
    const result = await proxyChatCompletion({
      req: {
        model: "client-m",
        messages: [{ role: "user", content: "hello world" }],
        stream: true,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(result.ok).toBe(true);
    if (result.body) {
      const reader = result.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("estimated");
    // "hello world" is 11 chars, ceil(11/4) = 3
    expect(logs[0].completionTokens).toBeGreaterThan(0);
  });
});
