/**
 * src/lib/proxy/openai.ts
 *
 * OpenAI Chat Completions compatible proxy.
 *
 * Flow:
 *   1. authenticateBearer(Authorization header, model)
 *   2. findProvidersForModel(clientModel)
 *   3. pick a provider (priority ascending, then first match)
 *   4. resolve upstream model from provider.modelMapping
 *   5. forward request to upstream URL with provider's decrypted API key
 *   6. parse response usage, compute 积分 consumed
 *   7. incrementQuotaUsed + recordUsage
 *   8. return wrapped response to the client
 *
 * The function is pure logic — the HTTP transport is abstracted behind
 * a `fetchImpl` parameter (defaults to global fetch) so tests can swap
 * in a mock.
 */
import { decryptSecret } from "../crypto/secrets";
import { findProvidersForModel, getProviderById } from "../db/providers";
import { recordUsage } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { estimateTokensFromText } from "../quota/calculator";
import { quotaDeltaFromUsage, shouldRejectBeforeRequest } from "../quota/calculator";
import { proxyAnthropicMessage } from "./anthropic";
import { settleUsage } from "./billing";
import { ssePassthrough } from "./stream-tap";
import type { ApiKey, Provider, User } from "../db/types";


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
 * Convert a Responses `input` value into a Chat Completions `messages` array.
 *
 * Handles the item types a Responses client actually sends:
 *   - plain strings, `{ role, content }` and `{ type: "message", … }`
 *   - `function_call`        → assistant message carrying `tool_calls`
 *   - `function_call_output` → `role: "tool"` message
 *   - `reasoning`            → dropped (server-side state, nothing to replay)
 */
function responsesInputToChatMessages(input: unknown): ChatMessage[] {
  const messages: ChatMessage[] = [];

  const pushMessage = (
    role: string,
    content: unknown,
    extra: Partial<ChatMessage> = {},
  ): void => {
    const mapped = responsesContentToChatContent(content);
    const hasContent = !(typeof mapped === "string" && mapped.length === 0);
    if (!hasContent && !extra.tool_calls) return;
    const message: ChatMessage = { role, ...extra };
    if (hasContent) message.content = mapped;
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

    if (type === "reasoning") return;

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

  const chatReq: ChatCompletionRequest = {
    model: req.model,
    messages: messages as unknown as Array<{ role: string; content: string }>,
    temperature: req.temperature as number | undefined,
    max_tokens:
      ((req.max_output_tokens ?? req.max_tokens) as number | undefined) ?? 1024,
    top_p: req.top_p as number | undefined,
    stream: false,
  };

  const tools = responsesToolsToChatTools(req.tools);
  if (tools) chatReq.tools = tools;
  const toolChoice = responsesToolChoiceToChatToolChoice(req.tool_choice);
  if (toolChoice !== undefined) chatReq.tool_choice = toolChoice;
  if (req.parallel_tool_calls !== undefined) {
    chatReq.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (typeof req.stop === "string" || Array.isArray(req.stop)) chatReq.stop = req.stop;

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

  return chatReq;
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
    | { role?: string; content?: unknown; tool_calls?: unknown }
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
 * Convert a Responses API request to the Anthropic Messages format.
 * Used when the selected provider only speaks the Anthropic protocol.
 */
export function responsesToAnthropicRequest(req: ResponseAPIRequest): Record<string, unknown> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  const fromInput = (input: unknown): void => {
    if (typeof input === "string") {
      messages.push({ role: "user", content: input });
      return;
    }
    if (Array.isArray(input)) {
      for (const item of input) fromInput(item);
      return;
    }
    if (input && typeof input === "object") {
      const item = input as Record<string, unknown>;
      const role = String(item.role ?? "user").toLowerCase() === "assistant" ? "assistant" : "user";
      const content = item.content;
      if (typeof content === "string") {
        messages.push({ role, content });
      } else if (Array.isArray(content)) {
        const text = content
          .map((block) => {
            if (typeof block === "string") return block;
            if (block && typeof block === "object") {
              const b = block as Record<string, unknown>;
              return typeof b.text === "string" ? b.text : "";
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) messages.push({ role, content: text });
      }
    }
  };

  fromInput(req.input);
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const maxTokens =
    typeof req.max_output_tokens === "number" ? req.max_output_tokens : 1024;
  const system = typeof req.instructions === "string" ? req.instructions : undefined;

  return {
    model: req.model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
    ...(typeof req.top_p === "number" ? { top_p: req.top_p } : {}),
    stream: false,
  };
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  [k: string]: unknown;
}

/**
 * Convert an Anthropic Messages response into an OpenAI Responses object.
 */
export function anthropicToResponsesResponse(
  body: AnthropicMessageResponse,
  originalReq: ResponseAPIRequest,
): Record<string, unknown> {
  const id = body.id ?? `resp_${Date.now()}`;
  const text = (body.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: body.model ?? originalReq.model,
    output: text
      ? [
          {
            id: `${id}_msg`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ]
      : [],
    output_text: text,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProxyResult {
  ok: boolean;
  status: number;
  /** Either an OpenAI ChatCompletion (or SSE stream) or a RelayAB error. */
  data?: unknown;
  /**
   * Set when the upstream body should be piped straight through to the client
   * instead of being buffered and re-serialized (used for SSE streaming).
   */
  body?: ReadableStream<Uint8Array>;
  /** Content-Type to use together with `body`. */
  contentType?: string;
  error?: { code: string; message: string };
}

export interface ProxyDeps {
  fetchImpl?: typeof fetch;
  /** Override the upstream URL (for tests). */
  upstreamUrlFor?: (provider: Provider) => string;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

interface ChatCompletionRequest {
  model: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  user?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Forward an OpenAI-compatible ChatCompletion request.
 *
 * This function is intentionally transport-agnostic: it returns a structured
 * result that the calling route handler serializes back to the client.
 *
 * @param req         Parsed OpenAI request body.
 * @param apiKey      Already-validated customer API key (from apikey.ts).
 * @param deps        Optional fetch override for testing.
 */
export async function proxyChatCompletion(args: {
  req: ChatCompletionRequest;
  apiKey: ApiKey;
  /** Owner of `apiKey`. Carries the quota pool and the model whitelist. */
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // 1. Re-validate the key (defensive: caller may have skipped).
  const status = checkKeyStatus({
    key: apiKey,
    user,
    requestedModel: req.model,
  });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(user);
  if (preFlight) {
    const http = reasonToHttp(preFlight.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }

  // 2. Pick a provider that supports this model.
  // Anthropic-format providers cannot accept a Chat Completions body, so they
  // are only eligible for the /anthropic endpoint.
  const providers = (await findProvidersForModel(req.model)).filter(
    (p) => effectiveUpstreamFormat(p) !== "anthropic",
  );
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];
  const upstreamModel = provider.modelMapping[req.model];

  // 3. Resolve the upstream URL.
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultUpstreamUrl(provider);

  // 4. Decrypt the upstream API key.
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Strip fields that the OpenAI Chat Completions spec defines but every
  // non-streaming upstream rejects as 400. `stream_options` is the common
  // one — OpenAI SDK clients set it by default to ask for a final usage
  // frame. We drop it before forwarding because we never set `stream: true`
  // here, and the upstream's validation surfaces it as a bad parameter.
  const forwardable: Record<string, unknown> = { ...req };
  delete forwardable.stream_options;

  // 5. Forward the request. Streaming clients get stream=true with the
  // `include_usage` flag so the upstream emits a final usage frame; buffered
  // clients get stream=false so the upstream returns a single JSON body.
  const wantStream = Boolean(req.stream);
  const forwardBody = wantStream
    ? {
        ...forwardable,
        model: upstreamModel,
        stream: true,
        stream_options: { include_usage: true },
      }
    : { ...forwardable, model: upstreamModel, stream: false };

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return { ok: false, status: 502, error: { code: "upstream_error", message: String(err) } };
  }

  // Streaming: pipe the upstream SSE through to the client and bill on flush.
  // Guard on the content-type so an upstream that ignores `stream: true` and
  // answers with plain JSON still takes the buffered path (the route turns
  // that JSON into a single-frame SSE for the client).
  if (wantStream && response.ok && response.body && isEventStream(response)) {
    const inputText = Array.isArray(req.messages)
      ? req.messages.map((m) => m.content ?? "").join("\n")
      : "";
    return streamChatAnswer({
      upstream: response,
      apiKey,
      provider,
      user,
      model: req.model,
      upstreamModel,
      inputText,
      signal,
    });
  }

  if (!response.ok) {
    // Record which URL failed — a bare status code is nearly undebuggable and
    // the usual cause is a provider `baseUrl` with a mismatched path suffix.
    const detail = await response.text().catch(() => "");
    const context = `${upstreamUrl} -> HTTP ${response.status}: ${detail.slice(0, 500)}`;
    console.error(`[relayab] chat upstream failure: ${context}`);
    await recordFailure({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: context,
    });
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_error",
        message: `Upstream returned ${response.status}`,
      },
    };
  }

  // 6. Parse + extract usage.
  const body = (await response.json()) as ChatCompletionResponse;
  // Responses API uses input_tokens/output_tokens, Chat uses prompt_tokens/completion_tokens
  const usage = body.usage ?? {};
  const promptTokens = (usage as any).prompt_tokens ?? (usage as any).input_tokens ?? 0;
  const completionTokens = (usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0;

  // 7. Persist usage + charge the owner's pool (shared with the streaming path).
  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
  });

  return { ok: true, status: 200, data: body };
}

interface ChatCompletionResponse {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the protocol a provider actually speaks.
 *
 * `kind: "anthropic"` implies the Anthropic Messages protocol, but the stored
 * `upstreamFormat` field defaults to `"responses"`. Without this mapping such a
 * provider would be treated as an OpenAI-protocol endpoint, so a Chat request
 * would be POSTed to `<base>/chat/completions` instead of `<base>/v1/messages`.
 */
function effectiveUpstreamFormat(provider: Provider): "responses" | "chat" | "anthropic" {
  if (provider.kind === "anthropic" && provider.upstreamFormat === "responses") {
    return "anthropic";
  }
  return provider.upstreamFormat;
}

function defaultUpstreamUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // This proxy always forwards a Chat Completions body, so the target must be
  // the upstream Chat Completions endpoint regardless of `upstreamFormat`.
  return `${cleanBase}/chat/completions`;
}

async function recordFailure(args: {
  apiKey: ApiKey;
  provider: Provider;
  model: string;
  upstreamModel: string;
  error: unknown;
}): Promise<void> {
  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.provider.id,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed: 0,
    status: "error",
    errorMessage: String(args.error),
  });
}

// ---------------------------------------------------------------------------
// Quota delta re-export for testing
// ---------------------------------------------------------------------------

export { quotaDeltaFromUsage };

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

interface ResponseAPIRequest {
  model: string;
  input?: string | Array<{ type: string; content?: string; audio?: unknown }>;
  tools?: unknown[];
  stream?: boolean;
  [k: string]: unknown;
}

interface ResponseAPIResponse {
  id: string;
  object: string;
  model: string;
  output: unknown[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  [k: string]: unknown;
}

/**
 * Forward an OpenAI Responses API request.
 * Maps to upstream /v1/responses endpoint.
 */
export async function proxyOpenAIResponse(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // 1. Validate key
  const status = checkKeyStatus({
    key: apiKey,
    user,
    requestedModel: req.model,
  });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(user);
  if (preFlight) {
    const http = reasonToHttp(preFlight.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }

  // 2. Pick provider
  const providers = await findProvidersForModel(req.model);
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];
  const upstreamModel = provider.modelMapping[req.model];

  // Providers that don't speak the Responses protocol natively are reached
  // through a conversion hop against their own endpoint.
  const providerFormat = effectiveUpstreamFormat(provider);
  if (providerFormat === "chat") {
    return proxyResponsesViaChat({ req, apiKey, user, signal, deps });
  }
  if (providerFormat === "anthropic") {
    return proxyResponsesViaAnthropic({ req, apiKey, user, signal, deps });
  }

  // 3. Build upstream URL - Responses API uses /responses
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultResponsesUrl(provider);


  // 4. Decrypt upstream key
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Strip OpenAI-only fields the upstream may reject (e.g. stream_options).
  const forwardable: Record<string, unknown> = { ...req };
  delete forwardable.stream_options;

  // 5. Forward request
  // Flatten the request's input into text once: it feeds the credit
  // calculation and the estimation fallback for a stream that never reports
  // usage.
  let inputText = "";
  if (typeof req.input === "string") {
    inputText = req.input;
  } else if (Array.isArray(req.input)) {
    inputText = req.input
      .filter((i) => i.type === "input_text" && i.content)
      .map((i) => i.content)
      .join(" ");
  }

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify({ ...forwardable, model: upstreamModel }),
    });
  } catch (err) {
    await recordFailureResponses({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return { ok: false, status: 502, error: { code: "upstream_error", message: String(err) } };
  }

  if (!response.ok) {
    const text = await response.text();
    await recordFailureResponses({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: `HTTP ${response.status}: ${text}`,
    });
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_error",
        message: `Upstream returned ${response.status}`,
      },
    };
  }

  // 6. Streaming clients (Codex CLI, OpenAI SDK with stream:true) expect an
  //    SSE body. Pipe the upstream bytes straight through instead of trying to
  //    parse them as JSON, and settle usage once the stream has finished.
  if (req.stream === true && isEventStream(response)) {
    return streamResponsesAnswer({
      upstream: response,
      apiKey,
      provider,
      user,
      model: req.model,
      upstreamModel,
      inputText,
      signal,
    });
  }

  // 7. Parse + extract usage.
  const body = (await response.json()) as ResponseAPIResponse;
  const usage = body.usage ?? {};
  const promptTokens = (usage as any).prompt_tokens ?? (usage as any).input_tokens ?? 0;
  const completionTokens =
    (usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0;
  const totalTokens = (usage as any).total_tokens ?? (promptTokens + completionTokens);

  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
  });

  return { ok: true, status: 200, data: body };
}

interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * True when the upstream answered with an SSE body. Some providers ignore
 * `stream: true` and reply with a buffered JSON completion; those must not be
 * piped through the SSE tap (they would bill as an empty estimate).
 */
function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Pull token usage out of a Responses SSE event payload, accepting both the
 * Chat (`prompt_tokens`) and Responses (`input_tokens`) spellings, at either
 * the top level or nested under `response`.
 */
function usageFromSsePayload(payload: unknown): StreamUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nested = record.response;
  const source =
    (record.usage as Record<string, unknown> | undefined) ??
    (nested && typeof nested === "object"
      ? ((nested as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined);
  if (!source) return null;

  const toInt = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  const promptTokens = toInt(source.prompt_tokens ?? source.input_tokens);
  const completionTokens = toInt(source.completion_tokens ?? source.output_tokens);
  const totalTokens = toInt(source.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Pipe an upstream SSE response through to the client untouched while
 * scanning `data:` lines for the usage block, then charge + record once the
 * stream completes.
 */
/**
 * Pipe an upstream Chat Completions SSE response through to the client
 * untouched while collecting output text and scanning for a usage frame.
 * On flush we bill via `usage` if seen, otherwise by `estimateTokensFromText`
 * of the input messages and the streamed output (per the project's chosen
 * policy for the "no usage frame" path).
 */
function streamChatAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  /** Best-effort input text for the estimation fallback. */
  inputText: string;
  /** Client request signal; firing it settles the usage row. */
  signal?: AbortSignal;
}): ProxyResult {
  const { upstream, apiKey, provider, user, model, upstreamModel, inputText, signal } = args;
  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: "Upstream returned an empty stream" },
    };
  }

  let usage: StreamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;
  let outputText = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const found = usageFromSsePayload(parsed);
      if (found) {
        usage = found;
        sawUsage = true;
      }
      // Best-effort: harvest the delta text so we can estimate tokens if the
      // upstream never sends a usage frame.
      const choices = (parsed as { choices?: unknown[] }).choices;
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const delta = (c as { delta?: { content?: unknown } }).delta;
          if (delta && typeof delta.content === "string") {
            outputText += delta.content;
          }
        }
      }
    } catch {
      // Partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const body = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    settle: async () => {
      const billingMode: "usage" | "estimated" = sawUsage ? "usage" : "estimated";
      if (!sawUsage) {
        console.warn(
          `[relayab] chat stream for model=${model} ended without a usage frame; estimating tokens`,
        );
      }
      const promptTokens = sawUsage
        ? usage.promptTokens
        : estimateTokensFromText(inputText);
      const completionTokens = sawUsage
        ? usage.completionTokens
        : estimateTokensFromText(outputText);
      await settleUsage({
        apiKey,
        provider,
        user,
        model,
        upstreamModel,
        promptTokens,
        completionTokens,
        billingMode,
      });
    },
  });

  return {
    ok: true,
    status: 200,
    body,
    contentType: upstream.headers.get("content-type") ?? "text/event-stream",
  };
}

function streamResponsesAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  /** Best-effort input text, used to estimate tokens if no usage frame arrives. */
  inputText: string;
  /** Client request signal; firing it settles the usage row. */
  signal?: AbortSignal;
}): ProxyResult {
  const { upstream, apiKey, provider, user, model, upstreamModel, inputText, signal } = args;
  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: "Upstream returned an empty stream" },
    };
  }

  let usage: StreamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;
  let outputText = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload) as unknown;
      const found = usageFromSsePayload(parsed);
      if (found) {
        usage = found;
        sawUsage = true;
      }
      // Harvest streamed output text so the estimate fallback has something
      // to measure when the upstream omits the usage frame.
      const record = parsed as { type?: string; delta?: unknown };
      if (record?.type === "response.output_text.delta" && typeof record.delta === "string") {
        outputText += record.delta;
      }
    } catch {
      // Partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const body = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    settle: async () => {
      // No usage frame means the client disconnected or maxDuration cut the
      // stream short. Bill by estimate from the text we did see, and mark the
      // row so the estimate is auditable.
      const billingMode: "usage" | "estimated" = sawUsage ? "usage" : "estimated";
      if (!sawUsage) {
        console.warn(
          `[relayab] responses stream for model=${model} ended without a usage frame; estimating tokens`,
        );
      }
      await settleUsage({
        apiKey,
        provider,
        user,
        model,
        upstreamModel,
        promptTokens: sawUsage ? usage.promptTokens : estimateTokensFromText(inputText),
        completionTokens: sawUsage ? usage.completionTokens : estimateTokensFromText(outputText),
        billingMode,
      });
    },
  });

  return {
    ok: true,
    status: 200,
    body,
    contentType: upstream.headers.get("content-type") ?? "text/event-stream",
  };
}

/**
 * Serve a Responses API request from a provider that only speaks Chat
 * Completions, by converting the request and the response.
 */
async function proxyResponsesViaChat(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const chatResult = await proxyChatCompletion({
    req: responsesToChatRequest(req),
    apiKey,
    user,
    signal,
    deps,
  });
  if (!chatResult.ok) {
    return { ok: false, status: chatResult.status, error: chatResult.error };
  }
  return {
    ok: true,
    status: 200,
    data: chatToResponsesResponse(chatResult.data as ChatCompletionResponse, req),
  };
}

/**
 * Serve a Responses API request from a provider that only speaks the
 * Anthropic Messages protocol, by converting the request and the response.
 */
async function proxyResponsesViaAnthropic(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const result = await proxyAnthropicMessage({
    req: responsesToAnthropicRequest(req) as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey,
    user,
    signal,
    deps,
  });
  if (!result.ok) {
    return { ok: false, status: result.status, error: result.error };
  }
  return {
    ok: true,
    status: 200,
    data: anthropicToResponsesResponse(result.data as AnthropicMessageResponse, req),
  };
}

function defaultResponsesUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // This proxy always forwards a Responses API body, so the target must be the
  // upstream Responses endpoint regardless of `upstreamFormat`.
  return `${cleanBase}/responses`;
}

async function recordFailureResponses(args: {
  apiKey: ApiKey;
  provider: Provider;
  model: string;
  upstreamModel: string;
  error: unknown;
}): Promise<void> {
  await recordUsage({
    apiKeyId: args.apiKey.id,
    userId: args.apiKey.userId,
    providerId: args.provider.id,
    model: args.model,
    upstreamModel: args.upstreamModel,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed: 0,
    status: "error",
    errorMessage: String(args.error),
  });
}
