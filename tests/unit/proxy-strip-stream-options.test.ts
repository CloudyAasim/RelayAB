/**
 * M1 regression: `stream_options` (OpenAI-SDK default payload) must not reach
 * the upstream — the non-streaming forwarder treats it as an unknown parameter
 * and returns 400, which we previously surfaced as 502.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";

const chatBody = () =>
  JSON.stringify({
    id: "x",
    object: "chat.completion",
    created: 1,
    model: "upstream-m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const anthropicBody = () =>
  JSON.stringify({
    id: "x",
    type: "message",
    role: "assistant",
    model: "upstream-m",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

async function setupChat(): Promise<{ key: Awaited<ReturnType<typeof createApiKey>>["key"]; user: Awaited<ReturnType<typeof getUserById>> }> {
  const u = await createUser({
    username: "stripc-" + Math.random().toString(36).slice(2, 6),
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
    apiKey: "sk-upstream-test",
    enabled: true,
    modelMapping: { "client-m": "upstream-m" },
  });
  return { key: r.key, user: (await getUserById(u.id))! };
}

async function setupAnthropic(): Promise<{ key: Awaited<ReturnType<typeof createApiKey>>["key"]; user: Awaited<ReturnType<typeof getUserById>> }> {
  const u = await createUser({
    username: "stripa-" + Math.random().toString(36).slice(2, 6),
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
    apiKey: "sk-upstream-test",
    enabled: true,
    modelMapping: { "client-m": "upstream-m" },
  });
  return { key: r.key, user: (await getUserById(u.id))! };
}

describe("proxy: stream_options is stripped before forwarding", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("chat completions: upstream body never contains stream_options", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async (_url: string, _init?: RequestInit) => new Response(chatBody(), { status: 200 }));
    const { key, user } = await setupChat();
    await proxyChatCompletion({
      req: {
        model: "client-m",
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true },
      },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    const init = (fetchMock.mock.calls[0]?.[1] as unknown as RequestInit | undefined);
    const sent = JSON.parse((init?.body ?? "{}") as string);
    expect(sent).not.toHaveProperty("stream_options");
    expect(sent.model).toBe("upstream-m");
    expect(sent.stream).toBe(false);
  });

  it("anthropic messages: upstream body never contains stream_options", async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async (_url: string, _init?: RequestInit) => new Response(anthropicBody(), { status: 200 }));
    const { key, user } = await setupAnthropic();
    await proxyAnthropicMessage({
      req: {
        model: "client-m",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        stream_options: { include_usage: true } as never,
      },
      apiKey: key,
      user: user!,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    const init = (fetchMock.mock.calls[0]?.[1] as unknown as RequestInit | undefined);
    const sent = JSON.parse((init?.body ?? "{}") as string);
    expect(sent).not.toHaveProperty("stream_options");
  });
});
