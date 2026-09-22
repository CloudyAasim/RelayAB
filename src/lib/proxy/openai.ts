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
import { touchApiKeyLastUsed } from "../db/keys";
import { incrementUserQuotaUsed } from "../db/users";
import { recordUsage, quotaDelta } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { computeCredits } from "../quota/rates";
import { quotaDeltaFromUsage, shouldRejectBeforeRequest } from "../quota/calculator";
import { proxyAnthropicMessage } from "./anthropic";
import type { ApiKey, Provider, User } from "../db/types";


// ---------------------------------------------------------------------------
// Request/Response Format Converters (Responses <-> Chat Completions)
// ---------------------------------------------------------------------------

/**
 * Convert a Responses API request to Chat Completions format.
 */
// Responses <-> Chat Completions converters
export function responsesToChatRequest(req: ResponseAPIRequest): ChatCompletionRequest {
  const messages: Array<{ role: string; content: string | { type: string; [key: string]: unknown }[] }> = [];
  
  if (Array.isArray(req.input)) {
    for (const item of req.input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item && typeof item === "object") {
        const inputItem = item as Record<string, unknown>;
        if (inputItem.type === "message" && inputItem.content) {
          // Handle message content blocks (multi-modal)
          messages.push({
            role: String(inputItem.role ?? "user").toLowerCase(),
            content: inputItem.content as string | { type: string; [key: string]: unknown }[],
          });
        } else if (inputItem.role && inputItem.content) {
          messages.push({
            role: String(inputItem.role).toLowerCase(),
            content: String(inputItem.content),
          });
        }
      }
    }
  } else if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  }
  
  // Build extra_body for MiniMax-specific parameters
  const extraBody: Record<string, unknown> = {};
  const reqExtraBody = req.extra_body as Record<string, unknown> | undefined;
  if (reqExtraBody) {
    if (reqExtraBody.thinking !== undefined) extraBody.thinking = reqExtraBody.thinking;
    if (reqExtraBody.reasoning_split !== undefined) extraBody.reasoning_split = reqExtraBody.reasoning_split;
    if (reqExtraBody.service_tier !== undefined) extraBody.service_tier = reqExtraBody.service_tier;
  }
  
  const chatReq: ChatCompletionRequest = {
    model: req.model,
    messages: messages as Array<{ role: string; content: string }>,
    temperature: req.temperature as number | undefined,
    max_tokens: ((req.max_output_tokens ?? (req as Record<string, unknown>).max_tokens) as number | undefined) ?? 1024,
    top_p: req.top_p as number | undefined,
    stream: false,
  };
  
  if (Object.keys(extraBody).length > 0) {
    chatReq.extra_body = extraBody;
  }
  
  return chatReq;
}

// Responses <-> Chat Completions converters
export function chatToResponsesResponse(
  chatResp: ChatCompletionResponse,
  originalReq: ResponseAPIRequest,
): Record<string, unknown> {
  const message = chatResp.choices?.[0]?.message as
    | { role?: string; content?: unknown }
    | undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  const id = chatResp.id ?? `resp_${Date.now()}`;
  const usage = chatResp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;

  return {
    id,
    object: "response",
    created_at: chatResp.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatResp.model ?? originalReq.model,
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
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, deps } = args;
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

  // 5. Forward the request.
  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify({ ...req, model: upstreamModel, stream: false }),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return { ok: false, status: 502, error: { code: "upstream_error", message: String(err) } };
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
  const totalTokens = (usage as any).total_tokens ?? (promptTokens + completionTokens);
  // 积分 consumed, in integer 0.001-积分 units, so even a tiny request
  // registers a fraction of a 积分 instead of being rounded up to a whole one.
  const creditsUsed = computeCredits({
    model: upstreamModel,
    promptTokens,
    completionTokens,
  });

  // 7. Persist usage + charge the owner's pool.
  // The pool belongs to the USER, not the key: three keys held by the same
  // account all draw down one balance.
  const delta = quotaDelta({
    quotaType: user.quotaType,
    creditsUsed,
    totalTokens,
  });
  if (delta > 0) {
    await incrementUserQuotaUsed(apiKey.userId, delta);
    await touchApiKeyLastUsed(apiKey.id);
  }

  await recordUsage({
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerId: provider.id,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
    creditsUsed,
    status: "success",
  });

  return { ok: true, status: 200, data: body };
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
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
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, deps } = args;
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
    return proxyResponsesViaChat({ req, apiKey, user, deps });
  }
  if (providerFormat === "anthropic") {
    return proxyResponsesViaAnthropic({ req, apiKey, user, deps });
  }

  // 3. Build upstream URL - Responses API uses /responses
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultResponsesUrl(provider);


  // 4. Decrypt upstream key
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // 5. Forward request
  let response: Response;
  try {
    // Extract input text for credits calculation
    let inputText = "";
    if (typeof req.input === "string") {
      inputText = req.input;
    } else if (Array.isArray(req.input)) {
      inputText = req.input
        .filter((i) => i.type === "input_text" && i.content)
        .map((i) => i.content)
        .join(" ");
    }

    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify({ ...req, model: upstreamModel }),
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
  if (req.stream === true) {
    return streamResponsesAnswer({
      upstream: response,
      apiKey,
      provider,
      user,
      model: req.model,
      upstreamModel,
    });
  }

  // 7. Parse + extract usage.
  const body = (await response.json()) as ResponseAPIResponse;
  const usage = body.usage ?? {};
  const promptTokens = (usage as any).prompt_tokens ?? (usage as any).input_tokens ?? 0;
  const completionTokens =
    (usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0;
  const totalTokens = (usage as any).total_tokens ?? (promptTokens + completionTokens);

  await settleResponsesUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
    totalTokens,
  });

  return { ok: true, status: 200, data: body };
}

/**
 * Charge the owner's pool and record one usage row for a successful Responses
 * call. Shared by the buffered path and the streaming path.
 */
async function settleResponsesUsage(args: {
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): Promise<void> {
  const { apiKey, provider, user, model, upstreamModel } = args;
  const promptTokens = Math.max(0, Math.trunc(args.promptTokens));
  const completionTokens = Math.max(0, Math.trunc(args.completionTokens));
  const totalTokens = Math.max(0, Math.trunc(args.totalTokens));

  // 积分 consumed, in integer 0.001-积分 units, so even a tiny request
  // registers a fraction of a 积分 instead of being rounded up to a whole one.
  const creditsUsed = computeCredits({ model: upstreamModel, promptTokens, completionTokens });

  const delta = quotaDelta({ quotaType: user.quotaType, creditsUsed, totalTokens });
  if (delta > 0) {
    await incrementUserQuotaUsed(apiKey.userId, delta);
    await touchApiKeyLastUsed(apiKey.id);
  }

  await recordUsage({
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerId: provider.id,
    model,
    upstreamModel,
    promptTokens,
    completionTokens,
    creditsUsed,
    status: "success",
  });
}

interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
function streamResponsesAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
}): ProxyResult {
  const { upstream, apiKey, provider, user, model, upstreamModel } = args;
  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: "Upstream returned an empty stream" },
    };
  }

  const decoder = new TextDecoder();
  let pending = "";
  let usage: StreamUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawUsage = false;

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
    } catch {
      // Partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        consumeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      controller.enqueue(chunk);
    },
    async flush() {
      pending += decoder.decode();
      if (pending) consumeLine(pending);
      if (!sawUsage) {
        // The upstream never sent a usage frame. That happens when the client
        // disconnects or the function hits maxDuration mid-stream, and it means
        // this call cannot be billed accurately — make it visible rather than
        // silently recording zero.
        console.warn(
          `[relayab] responses stream for model=${model} ended without a usage frame; recording 0 tokens`,
        );
      }
      await settleResponsesUsage({
        apiKey,
        provider,
        user,
        model,
        upstreamModel,
        ...usage,
      });
    },
  });

  return {
    ok: true,
    status: 200,
    body: upstream.body.pipeThrough(tap),
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
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, deps } = args;
  const chatResult = await proxyChatCompletion({
    req: responsesToChatRequest(req),
    apiKey,
    user,
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
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, deps } = args;
  const result = await proxyAnthropicMessage({
    req: responsesToAnthropicRequest(req) as Parameters<typeof proxyAnthropicMessage>[0]["req"],
    apiKey,
    user,
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
