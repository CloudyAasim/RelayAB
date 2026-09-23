/**
 * Route-level streaming tests.
 *
 * The proxy unit tests cover the SSE tap; these exercise the actual route
 * handlers (auth → proxy → response) because that is where streaming broke
 * before: the route returned `NextResponse.json(...)` and the client received
 * a buffered body with no `data:` frames.
 *
 * The upstream is stubbed at the global-fetch level, which is what the route
 * handlers use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as chatPOST } from "@/app/api/v1/chat/completions/route";
import { POST as anthropicPOST } from "@/app/api/anthropic/v1/messages/route";

const CHAT_SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}}',
  "data: [DONE]",
  "",
].join("\n");

const ANTHROPIC_SSE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"up-model","content":[],"usage":{"input_tokens":5,"output_tokens":0}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":11}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

let apiKeyPlain: string;
let apiKeyId: string;

async function seed(kind: "openai" | "anthropic"): Promise<void> {
  await createProvider({
    name: kind === "anthropic" ? "Anth" : "OpenAI",
    kind,
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "client-m": "up-model" },
  });
  const user = await createUser({
    username: "route-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  apiKeyPlain = created.plainKey;
  apiKeyId = created.key.id;
}

function stubUpstream(body: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
}

describe("streaming routes", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POST /v1/chat/completions with stream:true returns SSE and bills", async () => {
    await seed("openai");
    stubUpstream(CHAT_SSE);

    const res = await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKeyPlain}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "client-m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // The upstream frames are forwarded verbatim, including the terminator.
    expect(text).toBe(CHAT_SSE);
    expect(text).toContain("data: [DONE]");

    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("usage");
    expect(logs[0].promptTokens).toBe(7);
    expect(logs[0].completionTokens).toBe(9);
  });

  it("POST /anthropic/v1/messages with stream:true returns SSE and bills", async () => {
    await seed("anthropic");
    stubUpstream(ANTHROPIC_SSE);

    const res = await anthropicPOST(
      new Request("http://localhost:3000/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKeyPlain,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "client-m",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toBe(ANTHROPIC_SSE);
    expect(text).toContain("event: message_stop");

    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("usage");
    expect(logs[0].promptTokens).toBe(5);
    expect(logs[0].completionTokens).toBe(11);
  });

  it("POST /v1/chat/completions with stream:true still rejects a bad key", async () => {
    await seed("openai");
    stubUpstream(CHAT_SSE);

    const res = await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer sk-relay-nope", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "client-m", messages: [], stream: true }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
