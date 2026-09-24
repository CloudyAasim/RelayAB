/**
 * src/lib/proxy/anthropic.ts
 *
 * Anthropic Messages API compatible proxy.
 *
 * Path: /anthropic/v1/messages
 * Upstream: Anthropic-compatible Provider (kind="anthropic")
 *
 * Behavior mirrors `proxy/openai.ts` with these differences:
 *   - Uses `max_tokens` (required by Anthropic).
 *   - Returns a "messages" response shape.
 *   - Provider selection: any Provider with `kind="anthropic"` that maps
 *     the requested client model.
 */
import { decryptSecret } from "../crypto/secrets";
import { findAnthropicProvidersForModel, getProviderById } from "../db/providers";
import { recordUsage } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { estimateTokensFromText } from "../quota/calculator";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { settleUsage } from "./billing";
import { ssePassthrough } from "./stream-tap";
import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnthropicProxyResult {
  ok: boolean;
  status: number;
  data?: unknown;
  /** SSE-passthrough body. Set when the proxy is streaming. */
  body?: ReadableStream<Uint8Array>;
  /** Content-Type to use together with `body`. */
  contentType?: string;
  error?: { code: string; message: string };
}

export interface AnthropicProxyDeps {
  fetchImpl?: typeof fetch;
  upstreamUrlFor?: (provider: Provider) => string;
}

interface AnthropicRequest {
  model: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop_sequence?: string | string[];
  /**
   * Extended thinking toggle. Anthropic only returns `thinking` blocks when
   * the caller asks for them (`{ type: "enabled", budget_tokens: N }`).
   */
  thinking?: unknown;
  [k: string]: unknown;
}

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function proxyAnthropicMessage(args: {
  req: AnthropicRequest;
  apiKey: ApiKey;
  /** Owner of `apiKey`. Carries the quota pool and the model whitelist. */
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: AnthropicProxyDeps;
}): Promise<AnthropicProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // Validate inputs.
  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }
  if (!req.max_tokens || req.max_tokens <= 0) {
    return { ok: false, status: 400, error: { code: "missing_max_tokens", message: "max_tokens is required" } };
  }

  // 1. Defensive re-validation (against the owner's policy, not the key's).
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

  // 2. Pick a provider whose Anthropic face is enabled for this model.
  //
  //    A vendor that speaks both protocols is one row now: the Anthropic face
  //    shares the row's API key, model mapping and model configs, and only
  //    carries its own base URL. Rows written before that model still work —
  //    they resolve to an Anthropic-only face.
  const candidates = await findAnthropicProvidersForModel(req.model);
  const provider = candidates[0];
  if (!provider) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No Anthropic provider configured for model '${req.model}'` },
    };
  }
  return doProxy({ req, apiKey, user, provider, signal, deps, fetchImpl });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function doProxy(args: {
  req: AnthropicRequest;
  apiKey: ApiKey;
  user: User;
  provider: Provider;
  signal?: AbortSignal;
  deps?: AnthropicProxyDeps;
  fetchImpl: typeof fetch;
}): Promise<AnthropicProxyResult> {
  const { req, apiKey, user, provider, signal, deps, fetchImpl } = args;
  const upstreamModel = provider.modelMapping[req.model];
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultUpstreamUrl(provider);

  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Same defensive strip as the OpenAI proxy: clients sometimes include
  // OpenAI-only fields like `stream_options` when reusing a request body.
  // The Anthropic Messages spec doesn't know about them.
  const forwardable: Record<string, unknown> = { ...req };
  delete forwardable.stream_options;

  // Streaming clients ask for SSE; buffered clients get a single JSON body.
  // Anthropic carries input tokens in `message_start` and output tokens in
  // `message_delta`, so the tap accumulates both before settling on flush.
  const wantStream = Boolean(req.stream);
  const forwardBody = wantStream
    ? { ...forwardable, model: upstreamModel, stream: true }
    : { ...forwardable, model: upstreamModel, stream: false };

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": upstreamKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: String(err) },
    };
  }

  // Streaming: pipe the upstream SSE through and settle usage on flush.
  // Guard on content-type: an upstream that ignores `stream: true` and answers
  // with JSON takes the buffered path instead (the route then synthesizes a
  // single-frame SSE for the client).
  if (wantStream && response.ok && response.body && isEventStream(response)) {
    const inputText = Array.isArray(req.messages)
      ? req.messages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .join("\n")
      : "";
    return streamAnthropicAnswer({
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
    // Surface *which* URL failed. A bare "Upstream 404" is almost impossible
    // to debug from the client: the usual cause is a provider `baseUrl` that
    // already ends in `/v1`, giving `<base>/v1/messages` -> 404. The detail is
    // logged and stored on the usage row (never returned to the caller).
    const detail = await response.text().catch(() => "");
    const context = `${upstreamUrl} -> HTTP ${response.status}: ${detail.slice(0, 500)}`;
    console.error(`[relayab] anthropic upstream failure: ${context}`);
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
      error: { code: "upstream_error", message: `Upstream ${response.status}` },
    };
  }

  const rawBody = (await response.json()) as AnthropicResponse;
  // Some upstreams (reasoning models behind an Anthropic-compatible face)
  // always emit a leading `thinking` block. The Anthropic contract says those
  // blocks are only sent when the caller enabled thinking, and clients that
  // read `content[0]` — ONLYOFFICE's AI plugin does exactly that — would show
  // an empty answer instead of the text that follows. Drop what was not asked
  // for; keep everything when thinking *was* requested.
  const body = isThinkingRequested(req) ? rawBody : stripUnrequestedThinking(rawBody);
  const usage = body.usage ?? { input_tokens: 0, output_tokens: 0 };
  // Charge the OWNER's pool, not the key's — see the note in billing.ts.
  await settleUsage({
    apiKey,
    provider,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    user,
    model: req.model,
    upstreamModel,
  });

  return { ok: true, status: 200, data: body };
}

/** Block types that carry reasoning rather than the answer. */
const REASONING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Did the caller ask the model to think out loud?
 *
 * Per the Anthropic Messages API, reasoning blocks are only returned when the
 * request enables them with `thinking: { type: "enabled", budget_tokens: N }`.
 * A `{ type: "disabled" }` (or a missing field) means "do not send them".
 */
export function isThinkingRequested(req: { thinking?: unknown }): boolean {
  const thinking = req?.thinking;
  if (!thinking || typeof thinking !== "object") return false;
  return (thinking as { type?: unknown }).type === "enabled";
}

/**
 * Remove reasoning blocks the caller never asked for.
 *
 * Reasoning models served through an Anthropic-compatible upstream often send
 * `content: [{type:"thinking"}, {type:"text"}]` unconditionally. Clients that
 * read `content[0]` — ONLYOFFICE's AI plugin resolves the answer that way —
 * then render nothing at all, because the first block has no `text` field
 * while the real answer sits in the second one.
 *
 * Returns the input untouched when there is nothing to drop, so the common
 * (text-only) case keeps the exact upstream payload.
 */
export function stripUnrequestedThinking<T extends { content?: unknown }>(body: T): T {
  if (!Array.isArray(body.content)) return body;

  const kept = body.content.filter((block) => {
    if (!block || typeof block !== "object") return true;
    const type = (block as { type?: unknown }).type;
    return !(typeof type === "string" && REASONING_BLOCK_TYPES.has(type));
  });

  if (kept.length === body.content.length) return body;
  return { ...body, content: kept };
}

function defaultUpstreamUrl(provider: Provider): string {
  const face = providerFaces(provider).anthropic;
  if (face?.baseUrl) return `${face.baseUrl.replace(/\/$/, "")}/v1/messages`;
  if (provider.baseUrl) return `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`;
  return "https://api.anthropic.com/v1/messages";
}

function streamAnthropicAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  inputText: string;
  /** Client request signal; firing it settles the usage row. */
  signal?: AbortSignal;
}): AnthropicProxyResult {
  const { upstream, apiKey, provider, user, model, upstreamModel, inputText, signal } = args;
  if (!upstream.body) {
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: "Upstream returned an empty stream" },
    };
  }

  let eventType = "";
  let dataBuf = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sawInput = false;
  let sawOutput = false;
  let outputText = "";

  const handleEvent = (rawEvent: string, rawData: string): void => {
    if (rawEvent === "message_start") {
      try {
        const parsed = JSON.parse(rawData) as { message?: { usage?: { input_tokens?: number } } };
        const usage = parsed.message?.usage;
        if (usage && typeof usage.input_tokens === "number") {
          inputTokens = Math.max(0, Math.trunc(usage.input_tokens));
          sawInput = true;
        }
      } catch { /* ignore */ }
    } else if (rawEvent === "message_delta") {
      try {
        const parsed = JSON.parse(rawData) as { usage?: { output_tokens?: number } };
        const usage = parsed.usage;
        if (usage && typeof usage.output_tokens === "number") {
          outputTokens = Math.max(0, Math.trunc(usage.output_tokens));
          sawOutput = true;
        }
      } catch { /* ignore */ }
    } else if (rawEvent === "content_block_delta") {
      try {
        const parsed = JSON.parse(rawData) as { delta?: { text?: string } };
        const text = parsed.delta?.text;
        if (typeof text === "string") outputText += text;
      } catch { /* ignore */ }
    }
  };

  const consumeLine = (line: string): void => {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      dataBuf += (dataBuf ? "\n" : "") + line.slice(5).trim();
      return;
    }
    if (line === "") {
      if (eventType || dataBuf) {
        handleEvent(eventType, dataBuf);
        eventType = "";
        dataBuf = "";
      }
    }
  };

  const body = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    // A trailing event whose blank-line separator never arrived still counts.
    onEnd: () => consumeLine(""),
    settle: async () => {
      const billingMode: "usage" | "estimated" =
        sawInput && sawOutput ? "usage" : "estimated";
      if (billingMode === "estimated") {
        console.warn(
          `[relayab] anthropic stream for model=${model} ended without complete usage; estimating tokens`,
        );
      }
      const promptTokens = sawInput ? inputTokens : estimateTokensFromText(inputText);
      const completionTokens = sawOutput ? outputTokens : estimateTokensFromText(outputText);
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

/**
 * True when the upstream answered with an SSE body. Providers that ignore
 * `stream: true` return buffered JSON instead; piping that through the SSE tap
 * would bill an empty estimate.
 */
function isEventStream(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
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

// Re-export so callers don't need a separate import.
export { getProviderById };
