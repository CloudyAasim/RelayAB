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
 *
 * The Responses surface (`/v1/responses`) needs its own synthesis: Codex CLI
 * always sends `stream: true`, and a `response.*` event sequence looks nothing
 * like a chat-completion chunk. Providers reached through the chat conversion
 * hop answer with a buffered `response` object, which this file replays as
 * `response.output_text.delta` (and `response.function_call_arguments.*`)
 * events.
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

  if (isResponsesShape(data)) {
    const body = responsesEvents(data)
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

interface ResponsesOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  [k: string]: unknown;
}

interface ResponsesLike {
  id: string;
  object?: string;
  created_at?: number;
  model?: string;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  [k: string]: unknown;
}

/**
 * Recognize a buffered Responses API object.
 *
 * Guarded on `object === "response"` (or an `output` array) plus `usage`, so a
 * Chat Completion — which also has `id`/`model`/`usage` — is never mistaken
 * for one.
 */
function isResponsesShape(data: unknown): data is ResponsesLike {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.choices)) return false;
  const looksLikeResponse = d.object === "response" || Array.isArray(d.output);
  return looksLikeResponse && typeof d.id === "string";
}

/**
 * Expand a buffered Responses object into the SSE event sequence a streaming
 * Responses client expects.
 *
 * The real endpoint emits events incrementally; replaying them from a buffered
 * body keeps the wire contract intact (clients only read the event stream, not
 * the wall-clock spacing). Text is delivered as one `output_text.delta` because
 * the upstream chat hop has already finished by the time we see it.
 */
function responsesEvents(buf: ResponsesLike) {
  const events: Array<{ type: string; data: unknown }> = [];
  const output = Array.isArray(buf.output) ? buf.output : [];
  const outputText = output
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");

  const base = { ...buf, output: [] as unknown[], output_text: "" };
  events.push({ type: "response.created", data: { type: "response.created", response: { ...base, status: "in_progress" } } });
  events.push({ type: "response.in_progress", data: { type: "response.in_progress", response: { ...base, status: "in_progress" } } });

  output.forEach((item, outputIndex) => {
    const itemId = String(item.id ?? `${buf.id}_item_${outputIndex}`);
    events.push({
      type: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, id: itemId, status: "in_progress" },
      },
    });

    if (item.type === "function_call") {
      const args = typeof item.arguments === "string" ? item.arguments : "";
      events.push({
        type: "response.function_call_arguments.delta",
        data: {
          type: "response.function_call_arguments.delta",
          item_id: itemId,
          output_index: outputIndex,
          delta: args,
        },
      });
      events.push({
        type: "response.function_call_arguments.done",
        data: {
          type: "response.function_call_arguments.done",
          item_id: itemId,
          output_index: outputIndex,
          arguments: args,
        },
      });
    }

    if (item.type === "message") {
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter((part) => part.type === "output_text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
      events.push({
        type: "response.content_part.added",
        data: {
          type: "response.content_part.added",
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      });
      if (text) {
        events.push({
          type: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            delta: text,
          },
        });
      }
      events.push({
        type: "response.output_text.done",
        data: {
          type: "response.output_text.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          text,
        },
      });
      events.push({
        type: "response.content_part.done",
        data: {
          type: "response.content_part.done",
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text, annotations: [] },
        },
      });
    }

    events.push({
      type: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { ...item, id: itemId, status: "completed" },
      },
    });
  });

  events.push({
    type: "response.completed",
    data: {
      type: "response.completed",
      response: { ...buf, status: "completed", output, output_text: outputText },
    },
  });
  return events;
}
