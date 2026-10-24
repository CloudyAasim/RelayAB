/**
 * src/lib/proxy/rerank.ts
 *
 * `POST /v1/rerank` — the reranking surface.
 *
 * ## Two dialects, one request
 *
 * Cohere and Jina disagree about the response but not about the request:
 * both take `{ model, query, documents, top_n }` and both answer with a
 * `results` array of `{ index, relevance_score, document }`. The differences
 * are additive — Cohere adds an `id` and a `meta.tokens` block — so the
 * upstream's body is forwarded untouched and both dialects work.
 *
 * What the two *do* disagree about is where the token counts are, and that
 * matters because it is what the call is billed on: Cohere puts them under
 * `meta.tokens`, Jina puts them under `usage`. Both are read.
 */
import { decryptSecret } from "../crypto/secrets";
import { findProvidersForModel } from "../db/providers";
import { recordUsage } from "../db/usage";
import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { settleUsage } from "./billing";
import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";
import type { ProxyDeps, ProxyResult } from "./types";

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents?: boolean;
  max_chunks_per_doc?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The request shape both dialects accept.
 *
 * `documents` has to be a list of strings: a reranker scores documents, and
 * anything else is a different request (a pre-embedded document list is
 * served by a vendor-specific endpoint, not this one).
 */
export function validateRerankBody(body: unknown): { ok: true } | { ok: false; message: string } {
  if (!isPlainObject(body)) return { ok: false, message: "The request body must be an object" };
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    return { ok: false, message: "model is required" };
  }
  if (typeof body.query !== "string") {
    return { ok: false, message: "query must be a string" };
  }
  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    return { ok: false, message: "documents must be a non-empty array" };
  }
  if (!body.documents.every((d) => typeof d === "string")) {
    return { ok: false, message: "every document must be a string" };
  }
  if (body.top_n !== undefined && (typeof body.top_n !== "number" || !Number.isInteger(body.top_n))) {
    return { ok: false, message: "top_n must be an integer" };
  }
  return { ok: true };
}

/** The upstream URL for the rerank endpoint. */
export function defaultRerankUrl(provider: Provider): string {
  const base = (provider.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
  return `${base}/rerank`;
}

/**
 * The token counts, from wherever the dialect put them.
 *
 * Cohere answers with `meta.tokens.{input_tokens,output_tokens}`; Jina and
 * the OpenAI-shaped vendors use `usage.{prompt_tokens,total_tokens}`. A
 * dialect that reports neither is billed on nothing — which is the honest
 * answer, since a rerank that says nothing about its size cannot be priced
 * by size.
 */
export function rerankUsage(payload: Record<string, unknown>): {
  promptTokens: number;
  completionTokens: number;
} {
  const toCount = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;

  const meta = isPlainObject(payload.meta) ? payload.meta : undefined;
  const tokens = isPlainObject(meta?.tokens) ? meta!.tokens : undefined;
  if (tokens) {
    return {
      promptTokens: toCount(tokens.input_tokens),
      completionTokens: toCount(tokens.output_tokens),
    };
  }

  const usage = isPlainObject(payload.usage) ? payload.usage : undefined;
  if (usage) {
    const prompt = toCount(usage.prompt_tokens) || toCount(usage.input_tokens);
    const total = toCount(usage.total_tokens);
    // A rerank produces a ranking, not text. Whatever the total is beyond the
    // prompt is the vendor's own accounting of the ranking itself, and it is
    // not output text.
    return { promptTokens: prompt, completionTokens: 0 };
  }

  return { promptTokens: 0, completionTokens: 0 };
}

/**
 * Forward a rerank request to the upstream that serves the model.
 *
 * Only OpenAI-shaped providers are eligible: the rerank endpoint is an
 * OpenAI-compatible convention that the Anthropic protocol does not have.
 */
export async function proxyRerank(args: {
  req: RerankRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  const status = checkKeyStatus({ key: apiKey, user, requestedModel: req.model });
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
   * Only a provider whose OpenAI face is served **natively** can serve a
   * rerank: the Anthropic Messages protocol has no rerank endpoint, and there
   * is nothing to translate one into. A row served by translation is still a
   * fine candidate for `/v1/chat/completions` — just not for this.
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
  const upstreamUrl = deps?.upstreamUrlFor ? deps.upstreamUrlFor(provider) : defaultRerankUrl(provider);
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  const body: Record<string, unknown> = {
    model: upstreamModel,
    query: req.query,
    documents: req.documents,
  };
  if (req.top_n !== undefined) body.top_n = req.top_n;
  if (req.return_documents !== undefined) body.return_documents = req.return_documents;
  if (req.max_chunks_per_doc !== undefined) body.max_chunks_per_doc = req.max_chunks_per_doc;

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
    console.error(`[relayab] rerank upstream failure: ${context}`);
    await recordFailure(apiKey, provider, req.model, upstreamModel, context);
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: `Upstream ${response.status}` },
    };
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const usage = rerankUsage(payload);

  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });

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
