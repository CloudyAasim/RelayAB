/**
 * src/lib/proxy/chat.ts
 *
 * The OpenAI Chat Completions **client** surface.
 *
 * The request is checked and a row is picked; then the row's own dialect
 * decides how it is reached — directly for a Chat Completions upstream, and
 * through the pivot for the ones that speak something else.
 */

import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { findProvidersForModel } from "../db/providers";
import { providerFaces, type ApiKey, type Provider, type User } from "../db/types";
import { sseRewrite } from "./stream-tap";
import { chatFrameMapper } from "../protocol/stream-frames";
import type { ChatCompletionRequest, ProxyDeps, ProxyResult } from "./types";
import { chatToResponsesRequest, responsesToChatResponse } from "./converters/chat";
import { proxyChatDirect } from "./dialects/chat";
import { proxyOpenAIResponse } from "./responses";

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
  // A provider whose upstream speaks something other than Chat Completions
  // cannot accept a Chat Completions body, so it is eligible for the
  // /anthropic endpoint and for the other surfaces **by translation**, which
  // is handled further down.
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

  /**
   * A provider whose upstream speaks a protocol the Chat Completions body
   * cannot be sent to is reached by translating: the request becomes a
   * Responses request, the Responses proxy turns that into the vendor's own
   * dialect, and the answer comes back the same way. A Chat Completions body
   * sent straight to an Anthropic or Gemini endpoint would be refused by the
   * upstream.
   *
   * A **Responses** upstream is deliberately not in this list. It has a
   * `/chat/completions` endpoint or it has not, and which one is the
   * operator's configuration to make: the Chat face has always posted a Chat
   * Completions body there, and switching it to the Responses endpoint would
   * change which endpoint a working deployment uses — and cost it the
   * incremental stream it has today.
   */
  const dialect = providerFaces(provider).openai?.format;
  if (dialect === "anthropic" || dialect === "gemini") {
    const viaPivot = await proxyOpenAIResponse({
      req: chatToResponsesRequest(req) as Parameters<typeof proxyOpenAIResponse>[0]["req"],
      apiKey,
      user,
      signal,
      deps,
    });
    if (!viaPivot.ok) {
      return { ok: false, status: viaPivot.status, error: viaPivot.error };
    }
    // The pivot speaks Responses; the client asked for Chat chunks. The
    // frames are translated on the way out.
    if (viaPivot.body) {
      const mapper = chatFrameMapper(req.model);
      return {
        ok: true,
        status: 200,
        body: sseRewrite(viaPivot.body, {
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
      data: responsesToChatResponse(viaPivot.data, req),
    };
  }

  // A Chat Completions body, straight to a Chat Completions upstream.
  return proxyChatDirect({ req, apiKey, user, signal, deps, provider });
}
