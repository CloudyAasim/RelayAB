/**
 * src/lib/assistant/client.ts
 *
 * Talks to the *user's own* upstream, in OpenAI-compatible chat-completions
 * shape. RelayAB's own providers are not involved: the assistant is configured
 * per user, so a conversation runs on whatever key that person supplied and
 * costs them that provider directly.
 *
 * Streaming and tool calls are handled in the same pass. Tool calls arrive as
 * index-keyed deltas (`delta.tool_calls[0].function.arguments` can be split
 * across many chunks), so the accumulator below reassembles them by index
 * while text is forwarded to the browser as it lands. Doing both in one pass is
 * what lets the final answer appear token-by-token *and* lets the assistant
 * call a tool in the same turn that explains it.
 */

export interface AssistantToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface UpstreamTurn {
  /** Text the model produced this turn. */
  content: string;
  /** Fully reassembled tool calls, if any. */
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** How the turn finished: "stop" ends the loop, "tool_calls" continues it. */
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface CallModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  messages: ChatMessage[];
  tools?: AssistantToolDef[];
  /** Called for each text delta, as it arrives. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/** Strip a trailing slash so `join` never produces a double slash. */
function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

function extractErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const err = (parsed as { error?: { message?: string } })?.error;
    if (typeof err?.message === "string" && err.message) return err.message;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 400);
}

/**
 * One turn against the upstream, streamed.
 *
 * Returns the reassembled turn. Text is only emitted through `onText` when the
 * upstream actually sent a content delta, so a tool-call-only turn produces
 * silence on the wire while still returning its calls.
 */
export async function callAssistantModel(opts: CallModelOptions): Promise<UpstreamTurn> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey}`,
    ...(opts.extraHeaders ?? {}),
  };

  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
  };

  try {
    const res = await fetch(`${normalizeBase(opts.baseUrl)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new UpstreamError(extractErrorMessage(text), res.status, text);
    }
    if (!res.body) {
      throw new UpstreamError("上游没有返回可读的响应流", 502);
    }

    return await readTurn(res.body, opts.onText);
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("请求超时或已取消", 504);
    }
    throw new UpstreamError(err instanceof Error ? err.message : String(err), 502);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Reassemble one streamed turn.
 *
 * `tool_calls` deltas are keyed by `index` and their `arguments` arrive in
 * pieces, so the entries have to be merged by index rather than appended — the
 * naive "push each delta" approach yields N fragments instead of N calls.
 */
async function readTurn(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
): Promise<UpstreamTurn> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  let finishReason: string | null = null;
  let usage: UpstreamTurn["usage"] = null;
  const partialCalls = new Map<number, { id: string; name: string; args: string }>();

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let payload: StreamChunk;
    try {
      payload = JSON.parse(data) as StreamChunk;
    } catch {
      // A vendor that emits keep-alive comments or a partial line is not a
      // reason to fail the turn; the next chunk carries the real payload.
      return;
    }

    if (payload.usage) {
      usage = {
        promptTokens: payload.usage.prompt_tokens ?? 0,
        completionTokens: payload.usage.completion_tokens ?? 0,
        totalTokens: payload.usage.total_tokens ?? 0,
      };
    }

    const choice = payload.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const text = choice.delta?.content;
    if (typeof text === "string" && text) {
      content += text;
      onText?.(text);
    }

    for (const call of choice.delta?.tool_calls ?? []) {
      const idx = typeof call.index === "number" ? call.index : partialCalls.size;
      const existing = partialCalls.get(idx) ?? { id: "", name: "", args: "" };
      if (call.id) existing.id = call.id;
      if (call.function?.name) existing.name += call.function.name;
      if (call.function?.arguments) existing.args += call.function.arguments;
      partialCalls.set(idx, existing);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineAt = buffer.indexOf("\n");
    while (newlineAt !== -1) {
      consume(buffer.slice(0, newlineAt));
      buffer = buffer.slice(newlineAt + 1);
      newlineAt = buffer.indexOf("\n");
    }
  }
  // A vendor that does not end its last event with a newline still counts.
  if (buffer.trim()) consume(buffer);

  const toolCalls = [...partialCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }))
    .filter((c) => c.function.name);

  return { content, toolCalls, finishReason, usage };
}

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/**
 * Non-streaming probe of a user's own upstream: does this base URL + key reach
 * a model, and what does it call them?
 *
 * Used by the settings screen to validate a configuration before it is saved,
 * and by the one-shot custom-model tester, where the key is supplied per
 * request and deliberately never persisted.
 */
export async function probeUpstream(opts: {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ ok: boolean; models: string[]; status: number; error?: string; latencyMs: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onAbort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(`${normalizeBase(opts.baseUrl)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.extraHeaders ?? {}),
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, models: [], status: res.status, error: extractErrorMessage(text), latencyMs };
    }

    const body: unknown = await res.json().catch(() => null);
    return { ok: true, models: extractModelIds(body), status: res.status, latencyMs };
  } catch (err) {
    return {
      ok: false,
      models: [],
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** `data[].id`, or a bare `models[]`; empty when the shape is unrecognised. */
function extractModelIds(body: unknown): string[] {
  const root = body as { data?: unknown; models?: unknown } | null;
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") ids.push(row);
    else if (row && typeof (row as { id?: unknown }).id === "string") {
      ids.push((row as { id: string }).id);
    }
  }
  return [...new Set(ids)].sort();
}
