/**
 * src/lib/proxy/moderations.ts
 *
 * `POST /v1/moderations` — the content moderation surface.
 *
 * ## Why it is its own file
 *
 * A moderation call is not a chat call with a different body: it has no
 * messages, no output tokens, and its answer is a verdict per input rather
 * than text. Reusing the chat path for it would mean inventing a fake message
 * and throwing the verdicts away.
 *
 * The shape on the wire is OpenAI's, and it is the shape every compatible
 * vendor already speaks — so the request goes out with the vendor's own model
 * name and the response comes back untouched.
 *
 * ## Billing
 *
 * A moderation answer carries no usage, so the prompt's tokens are estimated —
 * the same fallback the streaming path uses when a stream ends without a usage
 * frame. The price comes from the model's own row, because an operator prices
 * a model, not an endpoint.
 */
import { decryptSecret } from "../crypto/secrets";
import { findProvidersForModel } from "../db/providers";
import { recordUsage } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest, estimateTokensFromText } from "../quota/calculator";
import { settleUsage } from "./billing";
import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";
import type { ProxyDeps, ProxyResult } from "./types";

export interface ModerationsRequest {
  model: string;
  /** A string, or a list of strings. */
  input: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The input shapes OpenAI accepts, and nothing else.
 *
 * A bad input is refused here rather than forwarded: a vendor that answers
 * 400 for it costs a round trip and reports the error in its own words, which
 * is a worse answer than one that names the field.
 */
export function validateModerationsBody(
  body: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!isPlainObject(body)) return { ok: false, message: "The request body must be an object" };
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return { ok: false, message: "model is required" };
  }
  const input = body.input;
  const isString = typeof input === "string";
  const isStringArray = Array.isArray(input) && input.every((v) => typeof v === "string");
  if (!isString && !isStringArray) {
    return { ok: false, message: "input must be a string or an array of strings" };
  }
  return { ok: true };
}

/**
 * The upstream URL for the moderation endpoint.
 *
 * The provider's base URL is the same one a chat call uses (`.../v1` for
 * OpenAI), and the endpoint hangs off it — so a vendor that serves
 * `/v1/moderations` needs no separate configuration.
 */
export function defaultModerationsUrl(provider: Provider): string {
  const base = (provider.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  return `${base}/moderations`;
}

/** The prompt's text, for the estimate a moderation call is billed on. */
function moderationInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.filter((v): v is string => typeof v === "string").join("\n");
}

/**
 * Forward a moderation request to the upstream that serves the model.
 *
 * Every provider that maps the model and speaks an OpenAI-shaped protocol is
 * eligible — an Anthropic-format provider is not, because it has no
 * `/moderations` endpoint, and there is nothing to translate a verdict into.
 */
export async function proxyModerations(args: {
  req: ModerationsRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

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

  const providers = (await findProvidersForModel(req.model)).filter((p) => {
    const face = providerFaces(p).openai;
    return face !== null && face.format !== "anthropic";
  });
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];
  const upstreamModel = provider.modelMapping[req.model];
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultModerationsUrl(provider);
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Only the fields the endpoint defines. `stream` is not one of them: a
  // moderation call has nothing to stream.
  const body: Record<string, unknown> = { model: upstreamModel, input: req.input };

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await recordFailure(apiKey, provider, req.model, upstreamModel, err);
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: String(err) },
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const context = `${upstreamUrl} -> HTTP ${response.status}: ${detail.slice(0, 500)}`;
    console.error(`[relayab] moderations upstream failure: ${context}`);
    await recordFailure(apiKey, provider, req.model, upstreamModel, context);
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: `Upstream ${response.status}` },
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;

  // The vendor reports no usage for a moderation call, so the prompt's tokens
  // are estimated. There is nothing else to bill on.
  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens: estimateTokensFromText(moderationInputText(req.input)),
    completionTokens: 0,
  });

  // The upstream's own body: it is already the shape every moderation client
  // expects, and re-deriving it would only lose fields.
  return { ok: true, status: 200, data: payload };
}

async function recordFailure(
  apiKey: ApiKey,
  provider: Provider,
  model: string,
  upstreamModel: string,
  error: unknown,
): Promise<void> {
  await recordUsage({
    apiKeyId: apiKey.id,
    userId: apiKey.userId,
    providerId: provider.id,
    model,
    upstreamModel,
    promptTokens: 0,
    completionTokens: 0,
    creditsUsed: 0,
    status: "error",
    errorMessage: String(error),
  });
}
