/**
 * src/lib/proxy/dialects/chat.ts
 *
 * The upstream dialect: Chat Completions.
 *
 * A row that speaks Chat Completions is called in Chat Completions' own
 * shape, with no pivot and no translation in either direction.
 */

import { decryptSecret } from "../../crypto/secrets";
import { findProvidersForModel } from "../../db/providers";
import { estimateTokensFromText } from "../../quota/calculator";
import { extractCacheBuckets } from "../../quota/rates";
import { settleUsage } from "../billing";
import { ssePassthrough, sseRewrite } from "../stream-tap";
import { providerFaces, type ApiKey, type Provider, type User } from "../../db/types";
import { applyParameterPolicy } from "../../protocol/parameter-policy";
import { activeSpecFor } from "../../protocol/text-specs";
import { pivotFrameMapper } from "../../protocol/stream-frames";
import { upstreamRefusal } from "../errors";
import type {
  ChatCompletionRequest,
  ProxyDeps,
  ProxyResult,
  ResponseAPIRequest,
  StreamUsage,
} from "../types";
import { isEventStream, recordFailure, usageFromSsePayload } from "./shared";
import {
  chatToResponsesResponse,
  responsesToChatRequest,
  type ChatCompletionResponse,
} from "../converters/chat";

/**
 * Forward a Chat Completions request to an upstream that speaks it.
 *
 * The direct half of the Chat face: the body goes out in Chat
 * Completions' own shape and the answer comes back in it. No pivot and no
 * translation happen on this path.
 *
 * @param req         Parsed OpenAI request body.
 * @param apiKey      Already-validated customer API key (from apikey.ts).
 * @param deps        Optional fetch override for testing.
 */
export async function proxyChatDirect(args: {
  req: ChatCompletionRequest;
  apiKey: ApiKey;
  /** Owner of `apiKey`. Carries the quota pool and the model whitelist. */
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /**
   * The row to serve this request from.
   *
   * Absent means "pick one" — the usual case, where the Chat face resolves
   * the provider itself. It is passed when the caller has already chosen one:
   * the Anthropic face, for instance, picks from the rows that have an
   * Anthropic face, which is not the same set as the rows that have an OpenAI
   * one.
   */
  provider?: Provider;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps } = args;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  // The row to call: the one the caller chose, or the first that serves this
  // model and speaks Chat Completions.
  const providers = args.provider
    ? [args.provider]
    : (await findProvidersForModel(req.model)).filter((p) => providerFaces(p).openai !== null);
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

  // Strip fields that the OpenAI Chat Completions spec defines but every
  // non-streaming upstream rejects as 400. `stream_options` is the common
  // one — OpenAI SDK clients set it by default to ask for a final usage
  // frame. We drop it before forwarding because we never set `stream: true`
  // here, and the upstream's validation surfaces it as a bad parameter.
  const forwardable: Record<string, unknown> = { ...req };
  delete forwardable.stream_options;

  // The policy for *this* surface. A provider may carry several, one per
  // compatibility interface it serves, and the one that applies is the one the
  // client called — not whichever entry happens to be first in the list.
  // No entry for this surface means no policy, which is the correct default and
  // why an unconfigured deployment loses nothing.
  const { body: policed } = applyParameterPolicy(
    forwardable,
    activeSpecFor(provider, "openai-chat") ?? undefined,
  );

  // 5. Forward the request. Streaming clients get stream=true with the
  // `include_usage` flag so the upstream emits a final usage frame; buffered
  // clients get stream=false so the upstream returns a single JSON body.
  const wantStream = Boolean(req.stream);
  const forwardBody = wantStream
    ? {
        ...policed,
        model: upstreamModel,
        stream: true,
        stream_options: { include_usage: true },
      }
    : { ...policed, model: upstreamModel, stream: false };

  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    await recordFailure({ apiKey, provider, model: req.model, upstreamModel, error: err });
    return { ok: false, status: 502, error: { code: "upstream_error", message: String(err) } };
  }

  // Streaming: pipe the upstream SSE through to the client and bill on flush.
  // Guard on the content-type so an upstream that ignores `stream: true` and
  // answers with plain JSON still takes the buffered path (the route turns
  // that JSON into a single-frame SSE for the client).
  if (wantStream && response.ok && response.body && isEventStream(response)) {
    const inputText = Array.isArray(req.messages)
      ? req.messages.map((m) => m.content ?? "").join("\n")
      : "";
    return streamChatAnswer({
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
        message: upstreamRefusal(response.status, detail),
      },
    };
  }

  // 6. Parse + extract usage.
  const body = (await response.json()) as ChatCompletionResponse;
  // Responses API uses input_tokens/output_tokens, Chat uses prompt_tokens/completion_tokens
  const usage = body.usage ?? {};
  const promptTokens = (usage as any).prompt_tokens ?? (usage as any).input_tokens ?? 0;
  const completionTokens = (usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0;

  // 7. Persist usage + charge the owner's pool (shared with the streaming path).
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

  return { ok: true, status: 200, data: body };

}

/**
 * Serve a Responses API request from a provider that only speaks Chat
 * Completions, by converting the request and the response.
 */
export async function proxyResponsesViaChat(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  signal?: AbortSignal;
  deps?: ProxyDeps;
  /** The row to call, when the caller has already picked one. */
  provider?: Provider;
}): Promise<ProxyResult> {
  const { req, apiKey, user, signal, deps, provider } = args;
  const chatResult = await proxyChatDirect({
    req: responsesToChatRequest(req),
    apiKey,
    user,
    signal,
    deps,
    ...(provider ? { provider } : {}),
  });
  if (!chatResult.ok) {
    return { ok: false, status: chatResult.status, error: chatResult.error };
  }
  // The upstream answered in Chat's dialect; the pivot speaks Responses'. The
  // frames are translated on the way through, so the client sees the text as
  // it arrives instead of waiting for the whole answer.
  if (chatResult.body) {
    const mapper = pivotFrameMapper(req.model);
    return {
      ok: true,
      status: 200,
      body: sseRewrite(chatResult.body, {
        map: mapper.map,
        onEnd: mapper.onEnd,
        signal,
      }),
      contentType: "text/event-stream; charset=utf-8",
    };
  }
  return {
    ok: true,
    status: 200,
    data: chatToResponsesResponse(chatResult.data as ChatCompletionResponse, req),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultUpstreamUrl(provider: Provider): string {
  const base = provider.baseUrl ?? "https://api.openai.com";
  const cleanBase = base.replace(/\/$/, "");
  // This proxy always forwards a Chat Completions body, so the target must be
  // the upstream Chat Completions endpoint regardless of `upstreamFormat`.
  return `${cleanBase}/chat/completions`;
}

/**
 * Pipe an upstream SSE response through to the client untouched while
 * scanning `data:` lines for the usage block, then charge + record once the
 * stream completes.
 */
/**
 * Pipe an upstream Chat Completions SSE response through to the client
 * untouched while collecting output text and scanning for a usage frame.
 * On flush we bill via `usage` if seen, otherwise by `estimateTokensFromText`
 * of the input messages and the streamed output (per the project's chosen
 * policy for the "no usage frame" path).
 */
function streamChatAnswer(args: {
  upstream: Response;
  apiKey: ApiKey;
  provider: Provider;
  user: User;
  model: string;
  upstreamModel: string;
  /** Best-effort input text for the estimation fallback. */
  inputText: string;
  /** Client request signal; firing it settles the usage row. */
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
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const found = usageFromSsePayload(parsed);
      if (found) {
        usage = found;
        sawUsage = true;
      }
      // Best-effort: harvest the delta text so we can estimate tokens if the
      // upstream never sends a usage frame.
      const choices = (parsed as { choices?: unknown[] }).choices;
      if (Array.isArray(choices)) {
        for (const c of choices) {
          const delta = (c as { delta?: { content?: unknown } }).delta;
          if (delta && typeof delta.content === "string") {
            outputText += delta.content;
          }
        }
      }
    } catch {
      // Partial or non-JSON keep-alive frame — nothing to do.
    }
  };

  const body = ssePassthrough(upstream.body, {
    signal,
    onLine: consumeLine,
    settle: async () => {
      const billingMode: "usage" | "estimated" = sawUsage ? "usage" : "estimated";
      if (!sawUsage) {
        console.warn(
          `[relayab] chat stream for model=${model} ended without a usage frame; estimating tokens`,
        );
      }
      const promptTokens = sawUsage
        ? usage.promptTokens
        : estimateTokensFromText(inputText);
      const completionTokens = sawUsage
        ? usage.completionTokens
        : estimateTokensFromText(outputText);
      await settleUsage({
        apiKey,
        provider,
        user,
        model,
        upstreamModel,
        promptTokens,
        completionTokens,
        // Only when the upstream really reported it: an estimated turn has no
        // cache to report, and a 0 would turn a guess into a recorded fact.
        cache: sawUsage ? usage.cache : { read: 0, write: 0, reported: false },
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
