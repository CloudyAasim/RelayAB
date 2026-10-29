/**
 * src/lib/proxy/converters/chat.ts
 *
 * Responses <-> Chat Completions.
 *
 * The two surfaces share the envelope and disagree on nearly everything
 * inside it, so both directions of the conversion live here.
 */

import type { ChatCompletionRequest, ResponseAPIRequest } from "../types";

// ---------------------------------------------------------------------------
// Request/Response Format Converters (Responses <-> Chat Completions)
// ---------------------------------------------------------------------------

type ChatContentBlock = { type: string; [k: string]: unknown };
type ChatContent = string | ChatContentBlock[];

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: string;
  content?: ChatContent;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  /**
   * What the model thought, when the protocol says it has to be sent back.
   *
   * MiniMax puts it in `content` (inside `<think>` tags), DeepSeek and the
   * other OpenAI-compatible vendors put it in this field. Both read it from
   * either place, so this is where it goes.
   */
  reasoning_content?: string;
  [k: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; tool_calls?: unknown };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  [k: string]: unknown;
}

/**
 * Map one Responses content block onto its Chat Completions equivalent.
 *
 * The two protocols share the array-of-blocks envelope but not the block
 * types. Responses uses `input_text` / `output_text` / `input_image`, while
 * every OpenAI-compatible upstream expects `text` / `image_url`. Forwarding a
 * Responses block verbatim makes strict upstreams reject the whole request:
 * Agnes answers HTTP 500 `Invalid user message at index 0`.
 *
 * Returns null for blocks that carry nothing to forward.
 */
function responsesBlockToChatBlock(block: unknown): ChatContentBlock | null {
  if (typeof block === "string") {
    return block ? { type: "text", text: block } : null;
  }
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type : "";

  switch (type) {
    case "input_text":
    case "output_text":
    case "text":
    case "summary_text": {
      const text = typeof b.text === "string" ? b.text : "";
      return text ? { type: "text", text } : null;
    }
    case "refusal": {
      const text =
        typeof b.refusal === "string"
          ? b.refusal
          : typeof b.text === "string"
            ? b.text
            : "";
      return text ? { type: "text", text } : null;
    }
    case "input_image":
    case "image_url": {
      // Responses: { image_url: "https://…" } or { image_url: { url } }.
      const raw = b.image_url ?? b.url;
      const url =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).url === "string"
            ? String((raw as Record<string, unknown>).url)
            : "";
      return url ? { type: "image_url", image_url: { url } } : null;
    }
    default: {
      // Unknown block type: keep it only when it still carries plain text.
      const text = typeof b.text === "string" ? b.text : "";
      return text ? { type: "text", text } : null;
    }
  }
}

/**
 * Convert a Responses `content` value into Chat Completions `content`.
 *
 * A single text block collapses to a plain string, the form every upstream
 * accepts; multi-block content (text + images) stays an array.
 */
function responsesContentToChatContent(content: unknown): ChatContent {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) {
    const single = responsesBlockToChatBlock(content);
    return single && typeof single.text === "string" ? single.text : "";
  }

  const blocks: ChatContentBlock[] = [];
  for (const block of content) {
    const mapped = responsesBlockToChatBlock(block);
    if (mapped) blocks.push(mapped);
  }
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0].type === "text") {
    return typeof blocks[0].text === "string" ? blocks[0].text : "";
  }
  return blocks;
}

/**
 * The thinking a Responses client sent back, as plain text.
 *
 * A client that is told to echo the assistant's reasoning does so, and the
 * item carries it in whichever shape its vendor uses: a `reasoning_text`
 * string, a `content` array of `reasoning_text` blocks, or a `summary` array.
 * All of them are read, because the one thing worse than not understanding a
 * vendor's spelling is understanding only one of them.
 *
 * Empty when the item carries no readable text — an encrypted reasoning blob
 * is not something this gateway can replay, and sending an empty string would
 * be worse than sending nothing.
 */
function reasoningTextOf(item: Record<string, unknown>): string {
  const direct = item.reasoning_text ?? item.reasoning;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (typeof item.content === "string" && item.content.trim()) return item.content;

  const parts: string[] = [];
  for (const field of [item.content, item.summary]) {
    if (!Array.isArray(field)) continue;
    for (const block of field) {
      if (!block || typeof block !== "object") continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text) parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Convert a Responses `input` value into a Chat Completions `messages` array.
 *
 * Handles the item types a Responses client actually sends:
 *   - plain strings, `{ role, content }` and `{ type: "message", … }`
 *   - `function_call`        → assistant message carrying `tool_calls`
 *   - `function_call_output` → `role: "tool"` message
 *   - `reasoning`            → the assistant's thinking, carried across
 *
 * The reasoning used to be dropped here, on the grounds that it was "server-side
 * state, nothing to replay". That is exactly backwards for the vendors that
 * require it: DeepSeek refuses the continuation outright ("The `reasoning_text`
 * in the thinking mode must be passed back to the API"), and MiniMax says the
 * thinking has to be kept or the model's performance suffers. A gateway that
 * drops it on the way through breaks the conversation it was built to carry.
 *
 * So the text is read out of the item and hung on the assistant message that
 * follows it — which is where the vendor expects to find it.
 */
function responsesInputToChatMessages(input: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];
  /**
   * The thinking waiting for the assistant turn it belongs to. A Responses
   * `input` puts the reasoning item immediately before the assistant's own
   * item, so it is read one step ahead and attached when that item arrives.
   */
  let pendingReasoning = "";

  const pushMessage = (
    role: string,
    content: unknown,
    extra: Partial<ChatMessage> = {},
  ): void => {
    const mapped = responsesContentToChatContent(content);
    const hasContent = !(typeof mapped === "string" && mapped.length === 0);
    const reasoning = role === "assistant" ? pendingReasoning : "";
    // A user turn ends the pairing: reasoning that arrives before one belongs
    // to a turn that is no longer in the window.
    pendingReasoning = "";
    if (!hasContent && !extra.tool_calls && !reasoning) return;
    const message: ChatMessage = { role, ...extra };
    if (hasContent) message.content = mapped;
    if (reasoning) message.reasoning_content = reasoning;
    messages.push(message);
  };

  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      pushMessage("user", item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const it = item as Record<string, unknown>;
    const type = typeof it.type === "string" ? it.type : "";

    if (type === "reasoning") {
      pendingReasoning = reasoningTextOf(it);
      return;
    }

    if (type === "function_call") {
      const callId = String(it.call_id ?? it.id ?? `call_${messages.length}`);
      const args =
        typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {});
      pushMessage("assistant", "", {
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: String(it.name ?? ""), arguments: args },
          },
        ],
      });
      return;
    }

    if (type === "function_call_output") {
      const callId = String(it.call_id ?? it.id ?? "");
      const output =
        typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "");
      messages.push({ role: "tool", tool_call_id: callId, content: output });
      return;
    }

    if (type === "message" || it.role !== undefined) {
      const rawRole = String(it.role ?? "user").toLowerCase();
      // `developer` is the Responses spelling of `system`.
      pushMessage(rawRole === "developer" ? "system" : rawRole, it.content ?? "");
    }
  };

  visit(input);
  return messages;
}

/**
 * Convert Responses tool declarations into Chat Completions function tools.
 *
 * Responses declares functions flat (`{ type, name, description, parameters }`);
 * Chat Completions nests them under `function`. Already-nested declarations are
 * passed through. Hosted tools (web_search, …) have no Chat equivalent and are
 * dropped rather than forwarded as an invalid tool.
 */
function responsesToolsToChatTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: unknown[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    if (t.type !== "function") continue;
    if (t.function && typeof t.function === "object") {
      out.push(t);
      continue;
    }
    const fn: Record<string, unknown> = { name: String(t.name ?? "") };
    if (typeof t.description === "string") fn.description = t.description;
    if (t.parameters !== undefined) fn.parameters = t.parameters;
    if (t.strict !== undefined) fn.strict = t.strict;
    out.push({ type: "function", function: fn });
  }
  return out.length > 0 ? out : undefined;
}

/** Convert a Responses `tool_choice` into its Chat Completions shape. */
function responsesToolChoiceToChatToolChoice(choice: unknown): unknown {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") return choice;
  if (typeof choice !== "object") return undefined;
  const c = choice as Record<string, unknown>;
  if (c.type !== "function") return undefined;
  if (c.function && typeof c.function === "object") return c;
  return { type: "function", function: { name: String(c.name ?? "") } };
}

/**
 * Fields the converter rebuilds, so the client's own spelling must not survive.
 *
 * These are *translated*, not dropped: the value is read from the request and
 * written back in Chat Completions shape further down. Forwarding the original
 * alongside the translation would send the upstream two spellings of one thing —
 * `tools` flat and nested, `max_output_tokens` and `max_tokens` — and the
 * upstream's answer to that is a 400 nobody can explain.
 */
const REBUILT_FIELDS = [
  "tools",
  "tool_choice",
  "max_output_tokens",
  "max_tokens",
  "reasoning",
  "text",
] as const;

/**
 * Fields that exist only on the Responses surface and mean nothing to a Chat
 * Completions upstream.
 *
 * This is a **denylist, not a whitelist**, and that is the whole fix. It used to
 * build the upstream body from a fixed list of fields it recognised, so anything
 * a Responses client sent and this file did not name — `reasoning.effort` above
 * all, plus `text`, `max_tool_calls`, `logprobs`, `top_logprobs`, `seed` — was
 * **silently dropped**. A client asking for high reasoning got the model's
 * default, with no error and nothing to notice. Forwarding the rest is what a
 * transparent relay should do; these are the ones that would confuse an upstream
 * that has never heard of them.
 */
const RESPONSES_ONLY_FIELDS = [
  "input",
  "instructions",
  "include",
  "previous_response_id",
  "store",
  "truncation",
  "prompt_cache_key",
  "text",
  "prompt",
  "max_tool_calls",
] as const;

/**
 * Responses' `reasoning.effort` in the spelling a Chat Completions upstream
 * understands.
 *
 * The two surfaces do not agree on the name: Responses nests it as
 * `reasoning: { effort: "high" }`, Chat Completions takes a flat
 * `reasoning_effort: "high"`. A client sends the first and, before this, the
 * second never reached the vendor at all.
 *
 * A vendor that spells it differently (MiniMax takes `extra_body.thinking`) is
 * the parameter-policy's job — see `lib/protocol/parameter-policy.ts` — rather
 * than a guess made here for every provider at once.
 */
function chatReasoningEffort(req: ResponseAPIRequest): string | undefined {
  const reasoning = (req as { reasoning?: unknown }).reasoning;
  if (!reasoning || typeof reasoning !== "object") return undefined;
  const effort = (reasoning as { effort?: unknown }).effort;
  return typeof effort === "string" ? effort : undefined;
}

/**
 * Convert a Responses API request to Chat Completions format.
 */
export function responsesToChatRequest(req: ResponseAPIRequest): ChatCompletionRequest {
  const messages: ChatMessage[] = [];

  // Responses clients (Codex CLI, the OpenAI SDK) carry the system prompt in
  // `instructions` rather than as a message. Dropping it silently downgrades
  // agent behaviour, so it becomes the leading system message.
  if (typeof req.instructions === "string" && req.instructions.trim().length > 0) {
    messages.push({ role: "system", content: req.instructions });
  }
  messages.push(...responsesInputToChatMessages(req.input));
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  // Everything the client asked for, minus what this file rebuilds and minus the
  // fields that are meaningless to a Chat Completions upstream. `model` is
  // replaced by the caller with the upstream name; `stream` is set by the caller.
  const forwarded: Record<string, unknown> = {};
  const dropped = [
    ...(REBUILT_FIELDS as readonly string[]),
    ...(RESPONSES_ONLY_FIELDS as readonly string[]),
  ];
  for (const [key, value] of Object.entries(req as Record<string, unknown>)) {
    if (dropped.includes(key)) continue;
    if (key === "model" || key === "stream" || value === undefined) continue;
    forwarded[key] = value;
  }

  const chatReq = {
    ...forwarded,
    model: req.model,
    messages,
    // Responses counts output tokens separately; Chat Completions calls the
    // same ceiling `max_tokens`. Either spelling the client used is honoured.
    max_tokens: (req.max_output_tokens ?? (req as { max_tokens?: number }).max_tokens) ?? 1024,
    // The stream flag travels: a client that asked for a stream gets one, and
    // the upstream's frames are translated into the pivot's rather than
    // arriving as one whole answer at the end.
    stream: req.stream === true,
  } as ChatCompletionRequest;

  const tools = responsesToolsToChatTools(req.tools);
  if (tools) chatReq.tools = tools;
  const toolChoice = responsesToolChoiceToChatToolChoice(req.tool_choice);
  if (toolChoice !== undefined) chatReq.tool_choice = toolChoice;
  if (req.parallel_tool_calls !== undefined) {
    chatReq.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (typeof req.stop === "string" || Array.isArray(req.stop)) chatReq.stop = req.stop;

  // The one field that has to be re-spelled rather than forwarded.
  const effort = chatReasoningEffort(req);
  if (effort !== undefined) chatReq.reasoning_effort = effort;

  // Build extra_body for MiniMax-specific parameters
  const extraBody: Record<string, unknown> = {};
  const reqExtraBody = req.extra_body as Record<string, unknown> | undefined;
  if (reqExtraBody) {
    if (reqExtraBody.thinking !== undefined) extraBody.thinking = reqExtraBody.thinking;
    if (reqExtraBody.reasoning_split !== undefined) extraBody.reasoning_split = reqExtraBody.reasoning_split;
    if (reqExtraBody.service_tier !== undefined) extraBody.service_tier = reqExtraBody.service_tier;
  }
  if (Object.keys(extraBody).length > 0) {
    chatReq.extra_body = extraBody;
  }

  // Structured output: the pivot's `text.format` is the Chat's
  // `response_format`, and it is the same instruction — a client that asked
  // for JSON and got prose has been answered wrongly.
  const format = responsesTextFormat(req.text);
  if (format) chatReq.response_format = format;

  return chatReq;
}

/**
 * The pivot's structured-output instruction, in Chat's vocabulary.
 */
function responsesTextFormat(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const text = value as Record<string, unknown>;
  const format = asRecord(text.format);
  if (!format) return undefined;

  const type = typeof format.type === "string" ? format.type : "";
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: typeof format.name === "string" ? format.name : "response",
        schema: format.schema,
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  return undefined;
}

/** A record, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Convert a Chat Completions response into a Responses API object.
 *
 * Tool calls become `function_call` output items so the client can run them
 * and post the results back; without that the agent loop stalls after the
 * first turn.
 */
export function chatToResponsesResponse(
  chatResp: ChatCompletionResponse,
  originalReq: ResponseAPIRequest,
): Record<string, unknown> {
  const message = chatResp.choices?.[0]?.message as
    | { role?: string; content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }
    | undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  const id = chatResp.id ?? `resp_${Date.now()}`;
  const usage = chatResp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  // A chat response that asked for tools must come back as Responses
  // `function_call` items, otherwise the client's agent loop has nothing to
  // execute and the conversation stalls after the first turn.
  const output: unknown[] = [];

  /**
   * The thinking, as a Responses `reasoning` item.
   *
   * It goes first because that is where the protocol puts it, and because a
   * client that is going to echo it back has to find it in the same place the
   * vendor's own Responses API would have put it.
   *
   * Without this the client never learns what the model thought, so it cannot
   * send it back, so the next turn is a continuation without the reasoning —
   * which is what DeepSeek refuses and what MiniMax says costs the model
   * performance. The gateway has to carry it across the boundary.
   */
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoning) {
    output.push({
      id: `rs_${id}`,
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: reasoning }],
    });
  }

  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const call of rawToolCalls) {
    if (!call || typeof call !== "object") continue;
    const c = call as Record<string, unknown>;
    const fn = (c.function ?? {}) as Record<string, unknown>;
    const callId = String(c.id ?? `call_${output.length}`);
    output.push({
      id: `fc_${callId}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: String(fn.name ?? ""),
      arguments:
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  if (text) {
    output.push({
      id: `${id}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  return {
    id,
    object: "response",
    created_at: chatResp.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatResp.model ?? originalReq.model,
    output,
    output_text: text,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    },
  };
}

/**
 * Convert a Chat Completions request into a Responses API request.
 *
 * The other direction of the pair that already exists, and it exists for the
 * same reason: a provider that only speaks Anthropic can serve an OpenAI
 * client, but only if the request can be carried into the shape the gateway
 * speaks internally first.
 *
 * The system prompt moves to `instructions` (the Responses way of saying it),
 * a tool result becomes a `function_call_output` item, and a tool call
 * becomes a `function_call` item — so an agent loop survives the trip.
 */
export function chatToResponsesRequest(
  chatReq: ChatCompletionRequest,
): Record<string, unknown> {
  const input: unknown[] = [];
  const instructions: string[] = [];

  // The declared type of `messages` is narrower than what a client actually
  // sends: a tool result carries `tool_call_id`, an assistant turn carries
  // `tool_calls`. The runtime shape is the one that matters here.
  const messages = (chatReq.messages ?? []) as ChatMessage[];

  for (const message of messages) {
    const role = String(message.role ?? "user");
    const assistant = role === "assistant";
    const blocks = chatContentBlocks(message.content, assistant);
    const text = blocks
      .filter((block) => typeof block.text === "string")
      .map((block) => String(block.text))
      .join("");

    if (role === "system" || role === "developer") {
      if (text) instructions.push(text);
      continue;
    }

    // A tool result is the answer to a call the model made. In the Responses
    // shape that is its own item, not a message.
    if (role === "tool" || role === "function") {
      input.push({
        type: "function_call_output",
        call_id: String(message.tool_call_id ?? `call_${input.length}`),
        output: text,
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "{}",
        });
      }
      if (!text) continue;
    }

    // The blocks, not just the text: an image the client sent is part of the
    // question, and dropping it makes the answer confidently wrong.
    if (blocks.length > 0) {
      input.push({ role: assistant ? "assistant" : "user", content: blocks });
    }
  }

  const out: Record<string, unknown> = { model: chatReq.model, input };
  if (instructions.length > 0) out.instructions = instructions.join("\n\n");
  // The stream flag travels: a client that asked for a stream gets one.
  if (chatReq.stream === true) out.stream = true;

  const maxTokens = chatReq.max_completion_tokens ?? chatReq.max_tokens;
  if (typeof maxTokens === "number") out.max_output_tokens = maxTokens;
  if (typeof chatReq.temperature === "number") out.temperature = chatReq.temperature;
  if (typeof chatReq.top_p === "number") out.top_p = chatReq.top_p;
  if (typeof chatReq.stop === "string" || Array.isArray(chatReq.stop)) out.stop = chatReq.stop;

  if (Array.isArray(chatReq.tools) && chatReq.tools.length > 0) {
    out.tools = chatReq.tools;
  }
  if (chatReq.tool_choice !== undefined) out.tool_choice = chatReq.tool_choice;

  // Structured output: the Chat spelling and the pivot's are the same
  // instruction in two vocabularies, and the instruction is not optional — a
  // client that asked for JSON and got prose has been answered wrongly.
  const format = chatResponseFormat(chatReq.response_format);
  if (format) out.text = { format };

  return out;
}

/**
 * A Chat message's content as pivot blocks.
 *
 * Both the text and the images. The images are the part that used to go
 * missing: a multimodal question that loses its picture still gets an answer,
 * and the answer is about something else.
 */
function chatContentBlocks(
  content: ChatContent | undefined,
  assistant: boolean,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const textType = assistant ? "output_text" : "input_text";

  if (typeof content === "string") {
    if (content) out.push({ type: textType, text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;

  for (const block of content) {
    if (typeof block === "string") {
      if (block) out.push({ type: textType, text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;

    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) out.push({ type: textType, text });
      continue;
    }
    if (type === "image_url" || type === "input_image") {
      const url = imageUrlOf(block);
      if (url) out.push({ type: "input_image", image_url: url });
    }
  }
  return out;
}

/**
 * The address of an image, wherever the item happens to keep it.
 *
 * The pivot writes `image_url` as a string and the OpenAI-shaped form writes it
 * as an object — both spellings turn up.
 */
export function imageUrlOf(item: Record<string, unknown>): string {
  const raw = item.image_url ?? item.url;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { url?: unknown }).url === "string") {
    return String((raw as { url: string }).url);
  }
  return "";
}

/**
 * The pivot's structured-output instruction, in Chat's vocabulary.
 *
 * Chat says `response_format`; the pivot says `text.format`. They are the same
 * instruction, and dropping it is the kind of loss nobody notices until the
 * client's JSON parse fails.
 */
function chatResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const format = value as Record<string, unknown>;
  const type = typeof format.type === "string" ? format.type : "";

  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const schema = format.json_schema ?? format.schema;
    const inner = (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>;
    return {
      type: "json_schema",
      name: typeof inner.name === "string" ? inner.name : "response",
      schema: inner.schema,
      ...(inner.strict !== undefined ? { strict: inner.strict } : {}),
    };
  }
  return undefined;
}

/**
 * Convert a Responses API object back into a Chat Completions answer.
 *
 * The mirror of {@link chatToResponsesResponse}: what the OpenAI SDK expects
 * to read, which is a `choices` array rather than an `output` array.
 */
export function responsesToChatResponse(
  body: unknown,
  originalReq: ChatCompletionRequest,
): Record<string, unknown> {
  const root = (body ?? {}) as Record<string, unknown>;
  const output = Array.isArray(root.output) ? root.output : [];

  let text = "";
  const toolCalls: unknown[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;

    if (entry.type === "message") {
      for (const block of Array.isArray(entry.content) ? entry.content : []) {
        if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
          text += (block as { text: string }).text;
        }
      }
      continue;
    }

    if (entry.type === "function_call") {
      toolCalls.push({
        id: String(entry.call_id ?? `call_${toolCalls.length}`),
        type: "function",
        function: {
          name: String(entry.name ?? ""),
          arguments:
            typeof entry.arguments === "string" ? entry.arguments : JSON.stringify(entry.arguments ?? {}),
        },
      });
    }
  }

  const usage = (root.usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);

  return {
    id: root.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Number(root.created_at ?? Math.floor(Date.now() / 1000)),
    model: root.model ?? originalReq.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.total_tokens ?? promptTokens + completionTokens),
    },
  };
}
