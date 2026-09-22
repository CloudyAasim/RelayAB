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
  const text = chatResp.choices?.[0]?.message?.content ?? "";
  
  return {
    id: chatResp.id ?? `resp_${Date.now()}`,
    object: "response",
    created: chatResp.created ?? Math.floor(Date.now() / 1000),
    model: chatResp.model ?? originalReq.model,
    choices: [
      {
        index: 0,
        finish_reason: chatResp.choices?.[0]?.finish_reason ?? "stop",
        message: chatResp.choices?.[0]?.message,
      },
    ],
    usage: chatResp.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
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
    await recordFailure({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: `HTTP ${response.status}`,
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

function defaultUpstreamUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // Use upstreamFormat to determine the endpoint
  switch (provider.upstreamFormat) {
    case "responses":
      return `${cleanBase}/responses`;
    case "anthropic":
      return `${cleanBase}/messages`;
    case "chat":
    default:
      return `${cleanBase}/chat/completions`;
  }
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

  // 6. Parse + extract usage.
  const body = (await response.json()) as ResponseAPIResponse;
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

  // 7. Persist usage
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

function defaultResponsesUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // Use upstreamFormat to determine the endpoint
  switch (provider.upstreamFormat) {
    case "responses":
      return `${cleanBase}/responses`;
    case "anthropic":
      return `${cleanBase}/messages`;
    case "chat":
    default:
      return `${cleanBase}/chat/completions`;
  }
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
