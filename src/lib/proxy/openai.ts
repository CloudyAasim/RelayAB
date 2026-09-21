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
import { incrementQuotaUsed } from "../db/keys";
import { recordUsage, quotaDelta } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { computeCredits } from "../quota/rates";
import { quotaDeltaFromUsage, shouldRejectBeforeRequest } from "../quota/calculator";
import type { ApiKey, Provider } from "../db/types";

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
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // 1. Re-validate the key (defensive: caller may have skipped).
  const status = checkKeyStatus({ key: apiKey, requestedModel: req.model });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(apiKey);
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
  const usage = body.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // 积分 consumed, in integer 0.001-积分 units, so even a tiny request
  // registers a fraction of a 积分 instead of being rounded up to a whole one.
  const creditsUsed = computeCredits({
    model: upstreamModel,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  });

  // 7. Persist usage + bump quota.
  const delta = quotaDelta({
    quotaType: apiKey.quotaType,
    creditsUsed,
    totalTokens: usage.total_tokens,
  });
  if (delta > 0) await incrementQuotaUsed(apiKey.id, delta);

  await recordUsage({
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerId: provider.id,
    model: req.model,
    upstreamModel,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
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
  if (provider.baseUrl) return `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // Default to OpenAI's standard endpoint; Anthropic should use /messages.
  return "https://api.openai.com/v1/chat/completions";
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
