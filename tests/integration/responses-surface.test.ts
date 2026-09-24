/**
 * Route-level tests for the Responses surface (`/v1/responses`).
 *
 * Regression context: Agnes CN is reached through the chat conversion hop
 * (`upstreamFormat: "chat"`), because Agnes' own `/v1/responses` answers
 * HTTP 500 for every request. A Codex CLI call therefore:
 *
 *   1. sent `input` as message blocks — the converter forwarded `input_text`
 *      verbatim and the upstream rejected the request with HTTP 500,
 *      which the relay reported as `502 Bad Gateway`, and
 *   2. asked for `stream: true` — the buffered chat answer was returned as
 *      bare JSON, leaving the client's SSE parser with no frames.
 *
 * These tests pin the whole path: request conversion (what the upstream
 * receives) and response replay (what the client receives).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";

const CHAT_JSON = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "up-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
};

const CODEX_BODY = {
  model: "client-m",
  instructions: "You are a coding agent.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "say hi" }],
    },
  ],
  tools: [
    {
      type: "function",
      name: "shell",
      description: "run shell",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    },
  ],
  tool_choice: "auto",
  reasoning: { effort: "high", summary: "auto" },
  store: false,
  stream: true,
};

let apiKeyPlain = "";
let apiKeyId = "";
let upstreamBody: Record<string, unknown> | null = null;

async function seedChatProvider(): Promise<void> {
  await createProvider({
    name: "Chat Upstream",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat: "chat",
    modelMapping: { "client-m": "up-model" },
  });
  const user = await createUser({
    username: "resp-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  apiKeyPlain = created.plainKey;
  apiKeyId = created.key.id;
}

function stubUpstream(): void {
  upstreamBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      upstreamBody = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      return new Response(JSON.stringify(CHAT_JSON), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function responsesRequest(body: unknown): Request {
  return new Request("http://localhost:3000/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKeyPlain}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/responses via a chat-only provider", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("converts the Codex request body into a valid Chat Completions request", async () => {
    await seedChatProvider();
    stubUpstream();

    await responsesPOST(responsesRequest(CODEX_BODY));

    expect(upstreamBody).not.toBeNull();
    const sent = JSON.stringify(upstreamBody);
    // The upstream must never see a Responses-only block type.
    expect(sent).not.toContain("input_text");
    expect(upstreamBody?.messages).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "say hi" },
    ]);
    expect(upstreamBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "run shell",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      },
    ]);
    expect(upstreamBody?.tool_choice).toBe("auto");
  });

  it("replays the buffered answer as Responses SSE when the client streams", async () => {
    await seedChatProvider();
    stubUpstream();

    const res = await responsesPOST(responsesRequest(CODEX_BODY));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    for (const event of [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]) {
      expect(text).toContain(`event: ${event}`);
    }
    expect(text).toContain("Hello!");

    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(11);
    expect(logs[0].completionTokens).toBe(5);
  });

  it("returns a plain response object when the client does not stream", async () => {
    await seedChatProvider();
    stubUpstream();

    const res = await responsesPOST(responsesRequest({ ...CODEX_BODY, stream: false }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("Hello!");
    expect(body.status).toBe("completed");
  });
});
