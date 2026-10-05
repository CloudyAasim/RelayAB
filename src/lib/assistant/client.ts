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

/**
 * One piece of a message, in the OpenAI vision shape.
 *
 * Only what an arbitrary OpenAI-compatible upstream is reliably willing to
 * accept: text, and an image by data URL. There is no `file` part here because
 * support for one is a per-provider decision, and this client is configured
 * against whatever key the user pasted — sending a shape half of them reject
 * turns "look at my PDF" into a 400.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * A string for everything except a user turn that carries a picture, which
   * becomes the array form. Upstreams accept both, so this is the only
   * difference from what every other message here has always sent.
   */
  content: string | ContentPart[];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface UpstreamTurn {
  /** Text the model produced this turn. */
  content: string;
  /**
   * What the model thought, if it thought. Separate from the answer because it
   * arrives separately on most vendors and inside the text on the rest.
   */
  reasoning: string;
  /** Fully reassembled tool calls, if any. */
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  /** How the turn finished: "stop" ends the loop, "tool_calls" continues it. */
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface CallModelOptions {
  /** Unused when `transport` is set; the transport is the whole destination. */
  baseUrl?: string;
  /** Unused when `transport` is set — there is no secret to send. */
  apiKey?: string;
  model: string;
  extraHeaders?: Record<string, string>;
  messages: ChatMessage[];
  tools?: AssistantToolDef[];
  /** Called for each text delta, as it arrives. */
  onText?: (delta: string) => void;
  /** Called for each delta of the model thinking, as it arrives. */
  onReasoning?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The caller's own model parameters. Omitted from the request when unset,
   * because `temperature: undefined` is still a key the upstream has to
   * decide what to do with — and a value we invented is a value we chose for
   * somebody's model.
   */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** How hard the model thinks. Left off the body unless one is chosen. */
  reasoningEffort?: string;
  /**
   * Whether it thinks at all. Left off the body unless one is chosen.
   *
   * Its own option because it is its own parameter. `reasoning_effort` answers
   * "how hard" on the vendors that publish levels; this answers "whether", and
   * on MiniMax they are different fields — so a client that could only send the
   * first had no way to turn thinking off, and no way to say that was what it
   * wanted. Sent nested, as the vendors that accept it spell it.
   */
  thinkingType?: string;
  /**
   * Replaces the HTTP call. `baseUrl` and `apiKey` are then unused, which is why
   * the account path can leave them unset rather than pass a placeholder.
   */
  transport?: UpstreamTransport;
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

/**
 * How one turn reaches a model.
 *
 * The default is an HTTP call to the user's own upstream, authenticated with a
 * key they pasted. The account path cannot use that: the credential the system
 * issues on a user's behalf keeps only a sha256 of a secret that is dropped the
 * moment the row is created (`db/assistant-keys.ts`), so it provably cannot go
 * in an `Authorization` header. It is handed straight to this deployment's own
 * proxy instead — the same thing the assistant's tools have always done.
 *
 * So the transport is a parameter rather than a second client. Everything after
 * it — delta reassembly, tool-call stitching, the abort contract — is shared,
 * because that is the part that is easy to get subtly wrong twice.
 */
export type UpstreamTransport = (args: {
  body: unknown;
  signal: AbortSignal;
}) => Promise<ReadableStream<Uint8Array>>;

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
    // Each conditional, not `temperature: opts.temperature` — an explicit
    // undefined is still a key in the JSON body, and a key the upstream fills
    // in is a default this system chose rather than one the caller did.
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
    ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
    // An object, because a vendor that has this parameter takes a typed one, and
    // a bare string is a 400 rather than a near miss. Absent entirely when unset:
    // sending `thinking: {type: null}` would ask the vendor to turn thinking
    // off in a way it cannot answer, which is the opposite of leaving it alone.
    ...(opts.thinkingType !== undefined
      ? { thinking: { type: opts.thinkingType } }
      : {}),
    ...(opts.tools && opts.tools.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
  };

  try {
    let stream: ReadableStream<Uint8Array>;

    if (opts.transport) {
      // Throws UpstreamError itself, so the reporting below is identical.
      stream = await opts.transport({ body, signal: controller.signal });
    } else {
      // Making the address optional is what let the account path exist at all,
      // so the case where neither is present has to fail here rather than
      // become a fetch of "undefined/chat/completions".
      if (!opts.baseUrl || !opts.apiKey) {
        throw new UpstreamError("没有配置上游地址或密钥", 500);
      }
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
      stream = res.body;
    }

    return await readTurn(stream, opts.onText, opts.onReasoning);
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
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * The longest tail of `s` that could still turn into a tag once more text
 * arrives.
 *
 * Both tags have to be checked. A token boundary lands inside `<think>` as often
 * as inside `</think>`, and holding back only the opening one passes the
 * simple case while failing the one that actually happens.
 */
function undecidedTail(s: string): string {
  for (let n = Math.min(8, s.length); n > 0; n--) {
    const tail = s.slice(s.length - n);
    if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) return tail;
  }
  return "";
}

/**
 * A splitter for a vendor that wraps its answer in `<think>` tags.
 *
 * The tag arrives split across deltas — the opening in one chunk, the closing
 * several chunks later — so a per-chunk regex either misses it or truncates it.
 * Whatever could still become a tag is therefore held back and reconsidered with
 * the next chunk, and the loop runs until no tag is left, because one chunk can
 * carry several blocks and an answer can sit between them.
 *
 * The state lives in a closure created per call rather than in module scope for
 * a reason that only shows up in production: two turns in flight at once would
 * otherwise share one half-open tag, and the second would print its answer into
 * the first one's reasoning.
 */
export function makeThinkingSplitter(): (chunk: string) => { reasoning: string; text: string } {
  let open = false;
  let held = "";

  return (chunk: string): { reasoning: string; text: string } => {
    let rest = held ? held + chunk : chunk;
    let reasoning = "";
    let text = "";
    held = "";

    for (;;) {
      if (open) {
        const end = rest.indexOf(THINK_CLOSE);
        if (end < 0) {
          // No closing tag yet; may be a partial one, so keep the whole thing.
          held = rest;
          open = true;
          return { reasoning, text };
        }
        reasoning += rest.slice(0, end);
        rest = rest.slice(end + THINK_CLOSE.length);
        open = false;
        continue;
      }

      const at = rest.indexOf(THINK_OPEN);
      if (at < 0) {
        const keep = undecidedTail(rest);
        text += keep ? rest.slice(0, rest.length - keep.length) : rest;
        held = keep;
        return { reasoning, text };
      }
      // Answer text before the tag belongs to the answer, not to the reasoning.
      text += rest.slice(0, at);
      rest = rest.slice(at + THINK_OPEN.length);
      open = true;
    }
  };
}

async function readTurn(
  stream: ReadableStream<Uint8Array>,
  onText?: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): Promise<UpstreamTurn> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  let reasoning = "";
  const takeThinking = makeThinkingSplitter();
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
    // Thinking first, and split out of the text when the vendor inlines it.
    //
    // Two shapes reach this point. Some send thinking in its own field; others
    // wrap the answer in `<think>` tags. Reading only `content` handled the
    // first as silence and the second as an answer with the model's private
    // reasoning printed in the middle of it — which is why the reasoning reads
    // as a formatting problem in one case and as missing output in the other,
    // and why neither was recognisable as the same defect.
    const thinking = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof thinking === "string" && thinking) {
      reasoning += thinking;
      onReasoning?.(thinking);
    }

    if (typeof text === "string" && text) {
      const split = takeThinking(text);
      if (split.reasoning) {
        reasoning += split.reasoning;
        onReasoning?.(split.reasoning);
      }
      if (split.text) {
        content += split.text;
        onText?.(split.text);
      }
      return;
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

  return { content, reasoning, toolCalls, finishReason, usage };
}

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      /**
       * The thinking, when the vendor sends it separately.
       *
       * MiniMax puts it here and OpenAI-compatible vendors that think do the
       * same. It was not read, which is the same as not existing: the model
       * thought, the tokens were billed, and nothing reached the screen.
       */
      reasoning_content?: string | null;
      reasoning?: string | null;
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
