/**
 * tests/integration/streaming-dialects.test.ts
 *
 * A client that asked for a stream, against an upstream that speaks a dialect
 * of its own.
 *
 * Until now the conversion hops were buffered: a Responses client (Codex CLI,
 * the OpenAI SDK) against a Chat, Anthropic or Gemini upstream got the whole
 * answer at once, synthesised into a single SSE frame by the route. The text
 * was correct and the wire contract was intact, but nothing arrived until the
 * model was finished — which is exactly what a streaming client is not for.
 *
 * What is pinned here:
 *  - the text arrives **in pieces**, in the frames the client asked for;
 *  - the upstream is asked for a stream, and its frames are translated rather
 *    than dropped;
 *  - the call is still billed once, on the tokens the upstream reported.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as chatPOST } from "@/app/api/v1/chat/completions/route";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";

/** A Chat Completions upstream, streaming. */
const CHAT_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"he"}}]}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"}}]}',
  "",
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  "",
  'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

/** An Anthropic upstream, streaming. */
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-up","content":[],"usage":{"input_tokens":12,"output_tokens":0}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":30}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

/** A Gemini upstream, streaming. */
const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"he"}]},"index":0}],"modelVersion":"gemini-up","responseId":"resp_gemini_1"}',
  "",
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"llo"}]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":30,"totalTokenCount":42},"modelVersion":"gemini-up","responseId":"resp_gemini_1"}',
  "",
  "",
].join("\n");

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: UpstreamCall[] = [];

function stubSse(body: string): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { headers?: Record<string, string>; body?: unknown } = {}) => {
      calls.push({
        url: String(url),
        headers: init.headers ?? {},
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

async function seed(dialect: "chat" | "anthropic" | "gemini"): Promise<{
  plain: string;
  keyId: string;
}> {
  const user = await createUser({
    username: "s-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Upstream",
    kind: dialect === "anthropic" ? "anthropic" : "openai",
    baseUrl:
      dialect === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat: dialect,
    openaiEnabled: true,
    anthropicEnabled: dialect === "anthropic",
    modelMapping: { "client-m": "up-model" },
  });
  return { plain: created.plainKey, keyId: created.key.id };
}

function bearer(plain: string): Record<string, string> {
  return { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" };
}

/** The `data:` payloads of an SSE body, parsed. */
async function payloadsOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

describe("a streaming client against an upstream that speaks its own dialect", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the text in pieces, from a Chat upstream", async () => {
    const { plain, keyId } = await seed("chat");
    stubSse(CHAT_SSE);

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const payloads = await payloadsOf(res);
    const deltas = payloads.filter((p) => p.type === "response.output_text.delta");
    // Two pieces, not one whole answer: that is the whole point.
    expect(deltas).toHaveLength(2);
    expect(deltas.map((d) => d.delta)).toEqual(["he", "llo"]);

    const completed = payloads.find((p) => p.type === "response.completed");
    expect(completed).toBeTruthy();

    // The upstream was asked to stream.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].url).toBe("https://upstream.test/v1/chat/completions");

    // And the call was billed once, on the tokens the upstream reported.
    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(10);
    expect(rows[0].completionTokens).toBe(5);
  });

  it("delivers the text in pieces, from an Anthropic upstream", async () => {
    const { plain, keyId } = await seed("anthropic");
    stubSse(ANTHROPIC_SSE);

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const payloads = await payloadsOf(res);
    const deltas = payloads.filter((p) => p.type === "response.output_text.delta");
    expect(deltas.map((d) => d.delta)).toEqual(["he", "llo"]);

    // The upstream was asked to stream, in Anthropic's own shape.
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].url).toBe("https://upstream.test/v1/messages");

    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(12);
    expect(rows[0].completionTokens).toBe(30);
  });

  it("delivers the text in pieces, from a Gemini upstream", async () => {
    const { plain, keyId } = await seed("gemini");
    stubSse(GEMINI_SSE);

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi", stream: true }),
      }),
    );

    expect(res.status).toBe(200);
    const payloads = await payloadsOf(res);
    const deltas = payloads.filter((p) => p.type === "response.output_text.delta");
    expect(deltas.map((d) => d.delta)).toEqual(["he", "llo"]);

    // Google's streaming endpoint, and the query that makes it send SSE.
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/up-model:streamGenerateContent?alt=sse",
    );
    expect(calls[0].headers["x-goog-api-key"]).toBe("sk-upstream");

    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(12);
    expect(rows[0].completionTokens).toBe(30);
  });

  it("speaks Chat to a Chat client, when the upstream speaks Anthropic", async () => {
    // The pivot speaks Responses; the client asked for Chat chunks. The frames
    // have to change shape on the way out — twice, in this case.
    const { plain } = await seed("anthropic");
    stubSse(ANTHROPIC_SSE);

    const res = await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({
          model: "client-m",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());

    // Chat chunks, then the finish reason, the usage and [DONE].
    const chunks = payloads
      .filter((p) => p && p !== "[DONE]")
      .map((p) => JSON.parse(p) as Record<string, unknown>);
    const contents = chunks.flatMap((c) => {
      const choices = c.choices as Array<{ delta?: { content?: string } }> | undefined;
      return (choices ?? []).map((choice) => choice.delta?.content ?? "");
    });
    expect(contents.join("")).toBe("hello");
    expect(payloads[payloads.length - 1]).toBe("[DONE]");
  });
});
