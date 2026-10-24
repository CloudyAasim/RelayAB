/**
 * src/lib/proxy/dialects/gemini.ts
 *
 * The upstream dialect: Google Gemini.
 *
 * `contents` in, `candidates` out — the request is rewritten into Google's
 * own shape and the answer rewritten back.
 */

import { decryptSecret } from "../../crypto/secrets";
import { findOpenAIProvidersForModel } from "../../db/providers";
import { estimateTokensFromText } from "../../quota/calculator";
import { extractCacheBuckets } from "../../quota/rates";
import { settleUsage } from "../billing";
import { ssePassthrough, sseRewrite } from "../stream-tap";
import type { ApiKey, Provider, User } from "../../db/types";
import { applyParameterPolicy } from "../../protocol/parameter-policy";
import { activeSpecFor } from "../../protocol/text-specs";
import { pivotFrameMapper, readStreamFacts } from "../../protocol/stream-frames";
import {
  responsesToGeminiRequest,
  geminiToResponsesResponse,
} from "../../protocol/gemini";
import { upstreamRefusal } from "../errors";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest, StreamUsage } from "../types";
import { isEventStream, recordFailure } from "./shared";
import { pivotInputText } from "./responses";

/**
 * Serve a Responses API request from a provider that speaks Google's Gemini
 * API, by converting the request and the response.
 *
 * The endpoint is `POST {base}/models/{model}:generateContent` and the key
 * travels in `x-goog-api-key` — the carrier the Google SDKs use, and the one
 * the Gemini client face already accepts.
 *
 * The answer comes back whole rather than in frames: this path asks for
 * `generateContent`, not `streamGenerateContent`. A client that asked for a
 * stream still gets one — the route synthesises the frames from the buffered
 * answer, exactly as it does for a Chat Completions upstream.
 */
export async function proxyResponsesViaGemini(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /** The row to call, when the caller has already picked one. */
  provider?: Provider;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  const provider =
    args.provider ?? (await findOpenAIProvidersForModel(req.model))[0] ?? null;
  if (!provider) {
    return {
      ok: false,
      status: 400,
      error: {
        code: "model_not_mapped",
        message: `No provider configured for model '${req.model}'`,
      },
    };
  }

  const upstreamModel = provider.modelMapping[req.model];
  const wantStream = req.stream === true;
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultGeminiUrl(provider, upstreamModel, wantStream);
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  // The Responses surface's policy, applied before the conversion: the spec
  // says what this vendor calls things, and the conversion is downstream of it.
  const { body: policed } = applyParameterPolicy(
    { ...req },
    activeSpecFor(provider, "openai-responses") ?? undefined,
  );

  const geminiRequest = responsesToGeminiRequest(policed);

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": upstreamKey,
      },
      body: JSON.stringify(geminiRequest),
    });
  } catch (err) {
    await recordFailure({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: err,
    });
    return {
      ok: false,
      status: 502,
      error: { code: "upstream_error", message: String(err) },
    };
  }

  if (!response.ok) {
    const text = await response.text();
    const detail = `${upstreamUrl} -> HTTP ${response.status}: ${text.slice(0, 500)}`;
    console.error(`[relayab] gemini upstream failure: ${detail}`);
    await recordFailure({
      apiKey,
      provider,
      model: req.model,
      upstreamModel,
      error: detail,
    });
    return {
      ok: false,
      status: 502,
      error: {
        code: "upstream_error",
        message: upstreamRefusal(response.status, detail),
      },
    };
  }

  // The frames arrive as they are produced. Guard on the content type so an
  // upstream that ignores the streaming endpoint and answers with plain JSON
  // still takes the buffered path below.
  if (wantStream && response.body && isEventStream(response)) {
    return streamGeminiUpstream({
      upstream: response,
      apiKey,
      provider,
      user,
      model: req.model,
      upstreamModel,
      inputText: pivotInputText(req.input),
      signal,
    });
  }

  const body = await response.json();
  const pivot = geminiToResponsesResponse(body, req.model);
  const usage = (pivot.usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(usage.input_tokens ?? 0);
  const completionTokens = Number(usage.output_tokens ?? 0);

  await settleUsage({
    apiKey,
    provider,
    user,
    model: req.model,
    upstreamModel,
    promptTokens,
    completionTokens,
    cache: extractCacheBuckets(usage),
  });

  return { ok: true, status: 200, data: pivot };
}

/**
 * Read a Gemini stream and write the pivot's frames.
 *
 * The usage rides on the last chunk rather than in a frame of its own, so the
 * settlement reads it out of the frames as they go by — and the frames
 * themselves are translated on the way to the client.
 */
function streamGeminiUpstream(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  /** Best-effort prompt text, for the estimate fallback. */
  inputText: string;
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

  let usage: StreamUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cache: { read: 0, write: 0, reported: false },
  };
  let sawUsage = false;
  let outputText = "";

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const facts = readStreamFacts(JSON.parse(payload));
      if (facts.inputTokens !== undefined || facts.outputTokens !== undefined) {
        const promptTokens = facts.inputTokens ?? usage.promptTokens;
        const completionTokens = facts.outputTokens ?? usage.completionTokens;
        usage = {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          cache: usage.cache,
        };
        sawUsage = true;
      }
      if (facts.text) outputText += facts.text;
    } catch {
      // A partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const settled = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    settle: async () => {
      const billingMode: "usage" | "estimated" = sawUsage ? "usage" : "estimated";
      if (!sawUsage) {
        console.warn(
          `[relayab] gemini stream for model=${model} ended without usage; estimating tokens`,
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
        cache: sawUsage ? usage.cache : { read: 0, write: 0, reported: false },
        billingMode,
      });
    },
  });

  const mapper = pivotFrameMapper(model);
  return {
    ok: true,
    status: 200,
    body: sseRewrite(settled, { map: mapper.map, onEnd: mapper.onEnd, signal }),
    contentType: "text/event-stream; charset=utf-8",
  };
}

function defaultGeminiUrl(provider: Provider, upstreamModel: string, stream: boolean): string {
  const base = provider.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const cleanBase = base.replace(/\/+$/, "");
  // Google sends SSE only when asked for it with `alt=sse`; without it the
  // streaming endpoint answers with a JSON array of chunks.
  return stream
    ? `${cleanBase}/models/${encodeURIComponent(upstreamModel)}:streamGenerateContent?alt=sse`
    : `${cleanBase}/models/${encodeURIComponent(upstreamModel)}:generateContent`;
}
