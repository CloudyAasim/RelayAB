/**
 * Batch 2: streaming stopgap tests.
 *
 * When the client sends `stream: true` but the proxy returns a buffered
 * payload (chat/anthropic paths do not yet implement SSE passthrough),
 * `proxyResultToResponse` should synthesize a single-frame SSE response so
 * streaming SDK clients see a `data:` frame instead of an empty body.
 *
 * Batch 3 will replace this with true SSE passthrough; these tests guard
 * the stopgap contract until then.
 */
import { describe, it, expect } from "vitest";
import { proxyResultToResponse } from "@/lib/proxy/respond";
import type { ProxyResult } from "@/lib/proxy/openai";

function bufferedChat(): ProxyResult {
  return {
    ok: true,
    status: 200,
    data: {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "gpt-4o-mini",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  };
}

function bufferedAnthropic(): ProxyResult {
  return {
    ok: true,
    status: 200,
    data: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  };
}

describe("Batch 2 stopgap: proxyResultToResponse stream synthesis", () => {
  it("non-stream request returns buffered JSON, unchanged", async () => {
    const r = proxyResultToResponse(bufferedChat());
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const text = await r.text();
    const parsed = JSON.parse(text);
    expect(parsed.object).toBe("chat.completion");
    expect(parsed.choices[0].message.content).toBe("hi");
  });

  it("chat stream:true returns text/event-stream with the full text and [DONE]", async () => {
    const r = proxyResultToResponse(bufferedChat(), { streamRequest: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    const text = await r.text();
    expect(text).toMatch(/^data: \{.*"object":"chat\.completion\.chunk".*\}/m);
    expect(text).toContain('\"role\":\"assistant\"');
    expect(text).toContain('\"content\":\"hi\"');
    expect(text).toMatch(/data: \[DONE\]/);
  });

  it("anthropic stream:true returns event-stream with message_start / content_block_delta / message_stop", async () => {
    const r = proxyResultToResponse(bufferedAnthropic(), { streamRequest: true });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const text = await r.text();
    expect(text).toMatch(/event: message_start/);
    expect(text).toMatch(/event: content_block_start/);
    expect(text).toMatch(/event: content_block_delta/);
    expect(text).toMatch(/"text_delta"/);
    expect(text).toContain('\"text\":\"hello\"');
    expect(text).toMatch(/event: message_delta/);
    expect(text).toMatch(/event: message_stop/);
  });

  it("stream:true with unrecognized payload shape falls back to JSON", async () => {
    const weird: ProxyResult = { ok: true, status: 200, data: { foo: "bar" } };
    const r = proxyResultToResponse(weird, { streamRequest: true });
    expect(r.headers.get("content-type")).toContain("application/json");
  });
});
