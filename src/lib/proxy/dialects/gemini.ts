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
import { checkKeyStatus, reasonToHttp } from "../../auth/apikey";
import { shouldRejectBeforeRequest } from "../../quota/calculator";
import { applyParameterPolicy } from "../../protocol/parameter-policy";
import { activeSpecFor } from "../../protocol/text-specs";
import { pivotFrameMapper, readStreamFacts } from "../../protocol/stream-frames";
import {
  responsesToGeminiRequest,
  geminiToResponsesResponse,
  geminiUsage,
  geminiInputText,
  type GeminiGenerateRequest,
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
 * Forward a Gemini request to an upstream that speaks Gemini, verbatim.
 *
 * The direct half of the Gemini face: the body goes out in Google's own shape
 * and the answer comes back in it. No pivot and no translation in either
 * direction — which is the only reading of "原样透传" that means anything, and
 * the only way the fields the pivot has no place for (a thinking budget, a
 * safety setting) survive the trip.
 *
 * The endpoint is `POST {base}/models/{model}:generateContent` and the key
 * travels in `x-goog-api-key`, the same as the translated path: both reach
 * Google's own API, and only the shape of the body differs.
 */
export async function proxyGeminiDirect(args: {
  /** The client's body, exactly as it arrived. */
  body: GeminiGenerateRequest;
  /** The model the client named, before the row's mapping. */
  model: string;
  stream: boolean;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /** The row to call. */
  provider: Provider;
}): Promise<ProxyResult> {
  const { body, model, stream, apiKey, user, signal, deps, provider } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  /**
   * The checks every surface does before it talks to an upstream.
   *
   * This path does not go through the Responses proxy, so it does them for
   * itself — the same two, in the same order.
   */
  const status = checkKeyStatus({ key: apiKey, user, requestedModel: model });
  if (!status.ok) {
    const http = reasonToHttp(status.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }
  const preFlight = shouldRejectBeforeRequest(user);
  if (preFlight) {
    const http = reasonToHttp(preFlight.reason);
    return { ok: false, status: http.status, error: { code: http.code, message: http.message } };
  }

  const upstreamModel = provider.modelMapping[model];
  const upstreamUrl = deps?.upstreamUrlFor
    ? deps.upstreamUrlFor(provider)
    : defaultGeminiUrl(provider, upstreamModel, stream);
  const upstreamKey = decryptSecret(provider.encryptedApiKey);

  /**
   * The provider's parameter policy for *this* surface, applied before the
   * request leaves.
   *
   * No entry for `gemini-generate` means no policy, which is the correct
   * default: a provider configured for another surface has not opted this one
   * into anything.
   */
  const { body: policed } = applyParameterPolicy(
    { ...body } as Record<string, unknown>,
    activeSpecFor(provider, "gemini-generate") ?? undefined,
  );

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": upstreamKey,
      },
      body: JSON.stringify(policed),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model, upstreamModel, error: err });
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
    await recordFailure({ apiKey, provider, model, upstreamModel, error: detail });
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
  if (stream && response.body && isEventStream(response)) {
    return streamGeminiDirect({
      upstream: response,
      apiKey,
      provider,
      user,
      model,
      upstreamModel,
      inputText: geminiInputText(body),
      signal,
    });
  }

  // A whole answer, handed back as it arrived. Nothing is added to it and
  // nothing is taken out of it — that is the whole of this path.
  const answer = await response.json();
  const usage = geminiUsage(answer);

  await settleUsage({
    apiKey,
    provider,
    user,
    model,
    upstreamModel,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cache: {
      read: usage.cachedTokens,
      write: 0,
      reported: usage.cachedTokens > 0,
    },
  });

  /**
   * A client that asked for a stream and got a whole body.
   *
   * That is what happens against a vendor that ignores `alt=sse`: the frames
   * arrive as a JSON array of chunks, or as one body. The dialect is the same
   * on both ends, so nothing is translated — the answer is only framed, one
   * `data:` line per chunk, and handed over as the stream the client asked
   * for.
   */
  if (stream) {
    const chunks = Array.isArray(answer) ? answer : [answer];
    const frames = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n");
    return {
      ok: true,
      status: 200,
      body: new Response(`${frames}\n\n`).body!,
      contentType: "text/event-stream; charset=utf-8",
    };
  }

  return { ok: true, status: 200, data: answer };
}

/**
 * Read a Gemini stream and hand it over untouched.
 *
 * The frames are Google's own, so they go to the client as they are — the
 * only thing read out of them is the usage, which rides on the last chunk and
 * is what the call is billed by.
 */
function streamGeminiDirect(args: {
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
      const parsed = JSON.parse(payload);
      const facts = readStreamFacts(parsed);
      if (facts.text) outputText += facts.text;
      if (facts.inputTokens !== undefined || facts.outputTokens !== undefined) {
        usage = {
          promptTokens: facts.inputTokens ?? usage.promptTokens,
          completionTokens: facts.outputTokens ?? usage.completionTokens,
          totalTokens: (facts.inputTokens ?? usage.promptTokens) +
            (facts.outputTokens ?? usage.completionTokens),
          cache: usage.cache,
        };
        sawUsage = true;
      }
      // The cached slice of the prompt, which the frame reader does not carry.
      const cached = geminiUsage(parsed).cachedTokens;
      if (cached > 0) {
        usage = { ...usage, cache: { read: cached, write: 0, reported: true } };
      }
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

  return {
    ok: true,
    status: 200,
    body: settled,
    contentType: upstream.headers.get("content-type") ?? "text/event-stream",
  };
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
