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
import {
  findProvidersByKind,
  findProvidersForModel,
  getProviderById,
} from "../db/providers";
import { touchApiKeyLastUsed } from "../db/keys";
import { incrementUserQuotaUsed } from "../db/users";
import { recordUsage, quotaDelta } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { computeCredits } from "../quota/rates";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import type { ApiKey, Provider, User } from "../db/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnthropicProxyResult {
  ok: boolean;
  status: number;
  data?: unknown;
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
  deps?: AnthropicProxyDeps;
}): Promise<AnthropicProxyResult> {
  const { req, apiKey, user, deps } = args;
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

  // 2. Find an anthropic-kind provider that maps this model.
  const anthropicProviders = await findProvidersByKind("anthropic");
  const provider = anthropicProviders.find((p) => req.model in p.modelMapping);
  if (!provider) {
    // Fallback: any provider that maps the model (some Anthropic-compat
    // services aren't tagged as kind=anthropic but still speak the protocol).
    const fallbacks = await findProvidersForModel(req.model);
    const fb = fallbacks.find((p) => p.kind === "anthropic" || p.kind === "custom-openai");
    if (!fb) {
      return {
        ok: false,
        status: 400,
        error: { code: "model_not_mapped", message: `No Anthropic provider configured for model '${req.model}'` },
      };
    }
    return doProxy({ req, apiKey, user, provider: fb, deps, fetchImpl });
  }
  return doProxy({ req, apiKey, user, provider, deps, fetchImpl });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function doProxy(args: {
  req: AnthropicRequest;
  apiKey: ApiKey;
  user: User;
  provider: Provider;
  deps?: AnthropicProxyDeps;
  fetchImpl: typeof fetch;
}): Promise<AnthropicProxyResult> {
  const { req, apiKey, user, provider, deps, fetchImpl } = args;
  const upstreamModel = provider.modelMapping[req.model];
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultUpstreamUrl(provider);

  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": upstreamKey,
        "anthropic-version": "2023-06-01",
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
    return { ok: false, status: 502, error: { code: "upstream_error", message: `Upstream ${response.status}` } };
  }

  const body = (await response.json()) as AnthropicResponse;
  const usage = body.usage ?? { input_tokens: 0, output_tokens: 0 };
  // 积分 consumed (integer 0.001-积分 units); small requests are not rounded up.
  const creditsUsed = computeCredits({
    model: upstreamModel,
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
  });
  const totalTokens = usage.input_tokens + usage.output_tokens;
  // Charge the OWNER's pool, not the key's — see the note in openai.ts.
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
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    creditsUsed,
    status: "success",
  });

  return { ok: true, status: 200, data: body };
}

function defaultUpstreamUrl(provider: Provider): string {
  if (provider.baseUrl) return `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`;
  return "https://api.anthropic.com/v1/messages";
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
// silence unused-import warning
void findProvidersForModel;
