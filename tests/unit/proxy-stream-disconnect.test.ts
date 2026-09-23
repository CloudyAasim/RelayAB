/**
 * Streaming settlement on abrupt endings.
 *
 * A plain `pipeThrough(TransformStream)` only bills on `flush()`, which never
 * runs when the readable side is cancelled — so a client that hung up
 * mid-stream got the tokens for free. These tests pin the three endings:
 * normal completion, consumer cancel, and request abort. All three must write
 * exactly one usage row.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyChatCompletion } from "@/lib/proxy/openai";

/** Two content chunks and a usage frame, so a mid-stream cut has data to bill. */
const CHAT_SSE = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello world"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"again"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}',
  "data: [DONE]",
  "",
].join("\n");

async function setup(): Promise<{
  key: Awaited<ReturnType<typeof createApiKey>>["key"];
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
}> {
  const u = await createUser({
    username: "disc-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  await createProvider({
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    modelMapping: { "client-m": "up-model" },
  });
  const user = await getUserById(u.id);
  if (!user) throw new Error("setup: user missing");
  return { key: created.key, user };
}

/**
 * An upstream whose frames are pushed by the test, so a cancel lands at an
 * exact point instead of racing the stream's own buffering.
 */
function controllableUpstream(): {
  response: Response;
  push: (text: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (text) => {
      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        // The tap cancels the upstream when the client hangs up, so a later
        // push is a no-op.
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const ROLE_AND_CONTENT =
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n' +
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello world"},"finish_reason":null}]}\n\n';

const USAGE_FRAME =
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n';

async function waitForLogs(keyId: string, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    const logs = await listUsageByKey(keyId);
    if (logs.length > 0 || Date.now() - started > timeoutMs) return logs;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("streaming: settlement on abrupt endings", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("bills once on normal completion", async () => {
    const { key, user } = await setup();
    const up = controllableUpstream();
    const fetchMock = vi.fn(async () => up.response);
    const r = await proxyChatCompletion({
      req: { model: "client-m", messages: [{ role: "user", content: "hi" }], stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });
    up.push(ROLE_AND_CONTENT);
    up.push(USAGE_FRAME);
    up.close();
    await new Response(r.body!).text();

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("usage");
    expect(logs[0].completionTokens).toBe(6);
  });

  it("still bills when the consumer cancels mid-stream", async () => {
    const { key, user } = await setup();
    const up = controllableUpstream();
    const fetchMock = vi.fn(async () => up.response);
    const r = await proxyChatCompletion({
      req: { model: "client-m", messages: [{ role: "user", content: "hi" }], stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    // Deliver the text but not the usage frame, then hang up.
    up.push(ROLE_AND_CONTENT);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();

    const logs = await waitForLogs(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("estimated");
    // "hello world" (11 chars) → ceil(11/4) = 3 completion tokens
    expect(logs[0].completionTokens).toBe(3);
    expect(logs[0].status).toBe("success");
  });

  it("still bills when the request signal aborts", async () => {
    const { key, user } = await setup();
    const up = controllableUpstream();
    const fetchMock = vi.fn(async () => up.response);
    const controller = new AbortController();
    const r = await proxyChatCompletion({
      req: { model: "client-m", messages: [{ role: "user", content: "hi" }], stream: true },
      apiKey: key,
      user,
      signal: controller.signal,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    up.push(ROLE_AND_CONTENT);
    const reader = r.body!.getReader();
    await reader.read();
    controller.abort();

    const logs = await waitForLogs(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].billingMode).toBe("estimated");
    expect(logs[0].status).toBe("success");
  });

  it("never writes two rows when cancel is followed by completion", async () => {
    const { key, user } = await setup();
    const up = controllableUpstream();
    const fetchMock = vi.fn(async () => up.response);
    const r = await proxyChatCompletion({
      req: { model: "client-m", messages: [{ role: "user", content: "hi" }], stream: true },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    up.push(ROLE_AND_CONTENT);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    // Give any late settle path a chance to double-bill.
    await new Promise((res) => setTimeout(res, 150));

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
  });
});
