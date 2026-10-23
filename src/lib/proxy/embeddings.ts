/**
 * src/lib/proxy/embeddings.ts
 *
 * `POST /v1/embeddings` — the embedding surface.
 *
 * ## Why it is its own file
 *
 * An embedding call is not a chat call with a different body. It has no
 * messages, no output tokens, and a response whose payload is a vector per
 * input. Reusing the chat path for it would mean inventing a fake message and
 * throwing the vectors away.
 *
 * The shape on the wire is OpenAI's, and it is the shape every compatible
 * vendor already speaks — so the request goes out with the vendor's own model
 * name and the response comes back untouched.
 *
 * ## Billing
 *
 * Prompt tokens only: an embedding produces no output tokens. The price comes
 * from the same model row as a chat call, because an operator prices a model,
 * not an endpoint.
 */
import { decryptSecret } from "../crypto/secrets";
import { findProvidersForModel } from "../db/providers";
import { recordUsage } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { settleUsage } from "./billing";
import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";
import type { ProxyDeps, ProxyResult } from "./openai";

export interface EmbeddingsRequest {
  model: string;
  /** A string, a list of strings, or pre-tokenised inputs. */
  input: unknown;
  encoding_format?: string;
  dimensions?: number;
  user?: string;
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
export function validateEmbeddingsBody(body: unknown): { ok: true } | { ok: false; message: string } {
  if (!isPlainObject(body)) return { ok: false, message: "The request body must be an object" };
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return { ok: false, message: "model is required" };
  }
  const input = body.input;
  const isString = typeof input === "string";
  const isStringArray = Array.isArray(input) && input.every((v) => typeof v === "string");
  const isTokenArray =
    Array.isArray(input) && input.every((v) => typeof v === "number" && Number.isFinite(v));
  const isTokenMatrix =
    Array.isArray(input) &&
    input.every((v) => Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n)));
  if (!isString && !isStringArray && !isTokenArray && !isTokenMatrix) {
    return {
      ok: false,
      message: "input must be a string, an array of strings, an array of token ids, or an array of token-id arrays",
    };
  }
  if (body.dimensions !== undefined && (typeof body.dimensions !== "number" || !Number.isInteger(body.dimensions))) {
    return { ok: false, message: "dimensions must be an integer" };
  }
  return { ok: true };
}

/**
 * The upstream URL for the embedding endpoint.
 *
 * The provider's base URL is the same one a chat call uses (`.../v1` for
 * OpenAI), and the endpoint hangs off it — so a vendor that serves
 * `/v1/embeddings` needs no separate configuration.
 */
export function defaultEmbeddingsUrl(provider: Provider): string {
  const base = (provider.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  return `${base}/embeddings`;
}

/**
 * The token counts, from whichever spelling the vendor used.
 *
 * OpenAI reports `prompt_tokens`; several compatible vendors report
 * `input_tokens` instead. Both are read, and a missing count is zero rather
 * than a guess — an embedding call that reports nothing is billed on what the
 * vendor said, and on nothing else.
 */
export function embeddingsUsage(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
} {
  if (!isPlainObject(usage)) return { promptTokens: 0, completionTokens: 0 };
  const toCount = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
  const prompt = toCount(usage.prompt_tokens) || toCount(usage.input_tokens);
  const total = toCount(usage.total_tokens);
  // An embedding call has no completion tokens. A vendor that reports a total
  // larger than the prompt is counting something else; the difference is not
  // output text, so it is not billed as such.
  return { promptTokens: prompt, completionTokens: 0 };
}

/**
 * Forward an embedding request to the upstream that serves the model.
 *
 * Every provider that maps the model and speaks an OpenAI-shaped protocol is
 * eligible — an Anthropic-format provider is not, because it has no
 * `/embeddings` endpoint.
 */
export async function proxyEmbeddings(args: {
  req: EmbeddingsRequest;
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

  /**
   * Only a provider whose OpenAI face is served **natively** can serve
   * embeddings.
   *
   * The Anthropic Messages protocol has no embeddings endpoint, and there is no
   * translation for one — the gateway can rewrite a text request into
   * Anthropic's shape, but there is nothing to rewrite a vector into. So a
   * row whose OpenAI face is served by translation is not a candidate here,
   * even though it is a perfectly good candidate for `/v1/chat/completions`.
   */
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
    : defaultEmbeddingsUrl(provider);
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // Only the fields the endpoint defines. `stream` is not one of them: an
  // embedding call has nothing to stream.
  const body: Record<string, unknown> = { model: upstreamModel, input: req.input };
  if (req.encoding_format !== undefined) body.encoding_format = req.encoding_format;
  if (req.dimensions !== undefined) body.dimensions = req.dimensions;
  if (req.user !== undefined) body.user = req.user;

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
    console.error(`[relayab] embeddings upstream failure: ${context}`);
    await recordFailure(apiKey, provider, req.model, upstreamModel, context);
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: `Upstream ${response.status}` },
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const usage = embeddingsUsage(payload.usage);

  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });

  // The upstream's own body: it is already the shape every embedding client
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
