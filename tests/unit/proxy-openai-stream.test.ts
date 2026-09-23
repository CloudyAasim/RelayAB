/**
 * tests/unit/proxy-openai-stream.test.ts
 *
 * Regression tests for SSE passthrough on /v1/responses.
 *
 * Codex CLI always requests a stream (`stream: true`) when it uses the
 * Responses protocol. The proxy used to forward that flag upstream and then
 * call `response.json()` on the SSE body, which threw
 *   SyntaxError: Unexpected token 'e', "event: res"...
 * and surfaced to the client as a 500. These tests pin the passthrough and
 * the deferred usage accounting that replaced it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyOpenAIResponse } from "@/lib/proxy/openai";

const SSE_BODY = [
  "event: response.created",
  'data: {"type":"response.created","response":{"id":"resp_1","usage":null}}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"Hi"}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":22,"total_tokens":33}}}',
  "",
  "",
].join("\n");

async function setupUserAndKey() {
  const u = await createUser({
    username: "stream-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const result = await createApiKey({ userId: u.id, label: "l" });
  return { key: result.key, user: (await getUserById(u.id))! };
}

async function setupProvider(upstreamFormat: "responses" | "chat" | "anthropic") {
  await createProvider({
    name: "MiniMax-" + upstreamFormat,
    kind: upstreamFormat === "anthropic" ? "anthropic" : "openai",
    baseUrl: "https://api.minimax.cn/v1",
    apiKey: "sk-upstream",
    modelMapping: { "MiniMax-M3": "MiniMax-M3" },
    upstreamFormat,
  });
}

function sseResponse(): Response {
  return new Response(SSE_BODY, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("proxyOpenAIResponse streaming", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("passes the upstream SSE body through unchanged", async () => {
    await setupProvider("responses");
    const { key, user } = await setupUserAndKey();
    const fetchMock = vi.fn(async () => sseResponse());

    const r = await proxyOpenAIResponse({
      req: { model: "MiniMax-M3", input: "Hi", stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    expect(r.ok).toBe(true);
    expect(r.body).toBeInstanceOf(ReadableStream);
    expect(r.contentType).toContain("text/event-stream");
    expect(r.data).toBeUndefined();

    const text = await new Response(r.body!).text();
    expect(text).toBe(SSE_BODY);

    // The upstream request kept `stream: true`.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });

  it("records usage from the final response.completed event", async () => {
    await setupProvider("responses");
    const { key, user } = await setupUserAndKey();
    const fetchMock = vi.fn(async () => sseResponse());

    const r = await proxyOpenAIResponse({
      req: { model: "MiniMax-M3", input: "Hi", stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(r.ok).toBe(true);

    // Nothing is charged until the client has consumed the stream.
    expect(await listUsageByKey(key.id)).toHaveLength(0);

    await new Response(r.body!).text();

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(11);
    expect(logs[0].completionTokens).toBe(22);
    expect(logs[0].status).toBe("success");
  });

  it("does not treat a non-streaming request as a stream", async () => {
    await setupProvider("responses");
    const { key, user } = await setupUserAndKey();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          model: "MiniMax-M3",
          output: [],
          usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const r = await proxyOpenAIResponse({
      req: { model: "MiniMax-M3", input: "Hi" },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    expect(r.ok).toBe(true);
    expect(r.body).toBeUndefined();
    expect((r.data as Record<string, unknown>).object).toBe("response");
    expect((await listUsageByKey(key.id))[0].promptTokens).toBe(3);
  });

  it("estimates tokens (billingMode=estimated) when the stream ends without usage", async () => {
    await setupProvider("responses");
    const { key, user } = await setupUserAndKey();
    // A stream that is cut short: deltas arrive, but no response.completed.
    const truncated = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1","usage":null}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"Hello there"}',
      "",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () =>
      new Response(truncated, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const r = await proxyOpenAIResponse({
      req: { model: "MiniMax-M3", input: "Hi there", stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    expect(r.ok).toBe(true);
    await new Response(r.body!).text();

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("estimated");
    // "Hello there" = 11 chars → ceil(11/4) = 3
    expect(logs[0].completionTokens).toBe(3);
    // "Hi there" = 8 chars → ceil(8/4) = 2
    expect(logs[0].promptTokens).toBe(2);
  });
});
