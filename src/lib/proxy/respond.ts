/**
 * src/lib/proxy/respond.ts
 *
 * Turn a `ProxyResult` into an HTTP `Response`.
 *
 * Buffered results are serialized as JSON. When the proxy hands back a `body`
 * (SSE passthrough) the stream is forwarded as-is, with headers that stop
 * intermediate proxies from buffering it — Codex CLI and the OpenAI SDK rely
 * on receiving `text/event-stream` incrementally.
 *
 * When the client asked for `stream: true` but the proxy returned a buffered
 * payload (Batch 2 stopgap: chat/anthropic paths do not yet implement SSE
 * passthrough), we synthesize a single-frame SSE response from the buffered
 * data. Without this, streaming SDK clients see an empty response because
 * their SSE parser finds no `data:` frames. Real SSE passthrough replaces this
 * in Batch 3.
 */
import { NextResponse } from "next/server";
import type { ProxyResult } from "./openai";

export function proxyResultToResponse(result: ProxyResult, opts: { streamRequest?: boolean } = {}): Response {
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: result.status },
    );
  }

  if (result.body) {
    return new Response(result.body, {
      status: result.status,
      headers: {
        "Content-Type": result.contentType ?? "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (opts.streamRequest) {
    const synth = synthesizeStreamFromBuffered(result.data, result.contentType);
    if (synth) return synth;
  }

  return NextResponse.json(result.data, { status: result.status });
}

/**
 * Synthesize a single-frame SSE response from a buffered Chat Completion or
 * Anthropic message. Returns null if the payload shape is unrecognized — the
 * caller should fall back to JSON in that case.
 */
function synthesizeStreamFromBuffered(data: unknown, contentType?: string): Response | null {
  const ct = contentType ?? "text/event-stream; charset=utf-8";

  if (isChatCompletionShape(data)) {
    const body =
      chatCompletionChunks(data).map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n";
    return sseResponse(body, ct);
  }

  if (isAnthropicMessageShape(data)) {
    const body = anthropicMessageEvents(data)
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
      .join("");
    return sseResponse(body, ct);
  }

  return null;
}

function sseResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

interface ChatCompletionLike {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function isChatCompletionShape(data: unknown): data is ChatCompletionLike {
  return Boolean(
    data && typeof data === "object" && "choices" in (data as Record<string, unknown>) &&
      Array.isArray((data as ChatCompletionLike).choices),
  );
}

function chatCompletionChunks(buf: ChatCompletionLike) {
  const baseId = buf.id;
  const created = buf.created;
  const model = buf.model;
  const chunks: unknown[] = [];
  for (const choice of buf.choices) {
    const role = choice.message?.role ?? "assistant";
    const content = choice.message?.content ?? "";
    chunks.push({
      id: baseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: choice.index, delta: { role, content }, finish_reason: null }],
    });
    chunks.push({
      id: baseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: choice.index, delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
    });
  }
  if (buf.usage) {
    chunks.push({
      id: baseId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: buf.usage,
    });
  }
  return chunks;
}

interface AnthropicMessageLike {
  id: string;
  type: "message";
  model: string;
  role: "assistant";
  content: Array<{ type: string; text?: string; thinking?: string; signature?: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function isAnthropicMessageShape(data: unknown): data is AnthropicMessageLike {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "message" && Array.isArray(d.content) && typeof d.usage === "object";
}

function anthropicMessageEvents(buf: AnthropicMessageLike) {
  const events: Array<{ type: string; data: unknown }> = [];
  const textBlocks = buf.content.filter((b) => b.type === "text");
  const inputTokens = buf.usage?.input_tokens ?? 0;
  const outputTokens = buf.usage?.output_tokens ?? 0;

  events.push({
    type: "message_start",
    data: {
      type: "message_start",
      message: {
        id: buf.id,
        type: "message",
        role: "assistant",
        model: buf.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
  });

  for (const block of textBlocks) {
    const idx = buf.content.indexOf(block);
    events.push({
      type: "content_block_start",
      data: { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } },
    });
    events.push({
      type: "content_block_delta",
      data: { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: block.text ?? "" } },
    });
    events.push({
      type: "content_block_stop",
      data: { type: "content_block_stop", index: idx },
    });
  }

  events.push({
    type: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: buf.stop_reason, stop_sequence: buf.stop_sequence },
      usage: { input_tokens: 0, output_tokens: outputTokens },
    },
  });
  events.push({
    type: "message_stop",
    data: { type: "message_stop" },
  });
  return events;
}
