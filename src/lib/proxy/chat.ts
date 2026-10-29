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
import { dialectForSurface, servesSurface } from "../protocol/surface-routes";
import { sseRewrite } from "./stream-tap";
import { chatFrameMapper } from "../protocol/stream-frames";
import type { ChatCompletionRequest, ProxyDeps, ProxyResult } from "./types";
import { chatToResponsesRequest, responsesToChatResponse } from "./converters/chat";
import { proxyChatDirect } from "./dialects/chat";
import { proxyOpenAIResponse } from "./responses";
import { runBilledSearch } from "../search/billing";
import { WebSearchError } from "../assistant/web-search";
import { searchErrorHttp } from "../search/types";
import {
  applyChatSearchAnnotations,
  buildSearchContext,
  chatSearchLimit,
  lastChatUserText,
  sourcesFromResults,
  stripHostedSearchFields,
  wantsHostedChatSearch,
  withChatSearchAnnotationStream,
  withChatSearchContext,
  type WebSearchSource,
} from "./web-search-tool";

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

  // 2. Pick a provider that supports this model **and answers this surface**.
  //
  // The route table decides both: a provider that does not answer
  // `/v1/chat/completions` is not a candidate for it, whatever the model
  // mapping says — and a provider whose upstream speaks something other than
  // Chat Completions is reached by translation, which is handled further down.
  const providers = args.provider
    ? [args.provider]
    : (await findProvidersForModel(req.model)).filter((p) => servesSurface(p, "openai-chat"));
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];

  /**
   * The hosted web search, when the upstream cannot do it.
   *
   * A Chat Completions upstream has no such tool: a `web_search` tool in the
   * body is either refused outright or answered by a model that was never told
   * how to answer it. So the deployment searches, puts the results in front of
   * the model, and puts the sources on the answer.
   *
   * It happens here, **before** the request is dispatched, so that a request
   * which travels through the pivot is searched once and not twice.
   */
  let sources: WebSearchSource[] = [];
  let chatReq: ChatCompletionRequest = req;
  if (wantsHostedChatSearch(req)) {
    const prepared = await prepareHostedChatSearch({ req, user, apiKey });
    if ("error" in prepared) return prepared.error;
    chatReq = prepared.req;
    sources = prepared.sources;
  }

  /**
   * A provider whose upstream speaks a protocol the Chat Completions body
   * cannot be sent to is reached by translating: the request becomes a
   * Responses request, the Responses proxy turns that into the vendor's own
   * dialect, and the answer comes back the same way. A Chat Completions body
   * sent straight to an Anthropic or Gemini endpoint would be refused by the
   * upstream.
   *
   * Which dialect it is comes from the row's route for **this** surface, so a
   * vendor that publishes both `/v1/chat/completions` and `/v1/responses` can
   * serve the one natively and the other by translation — which a single
   * "upstream format" could never say.
   */
  const dialect = dialectForSurface(provider, "openai-chat");
  if (dialect && dialect !== "chat") {
    const viaPivot = await proxyOpenAIResponse({
      req: chatToResponsesRequest(chatReq) as Parameters<typeof proxyOpenAIResponse>[0]["req"],
      apiKey,
      user,
      signal,
      deps,
      surface: "openai-chat",
    });
    if (!viaPivot.ok) {
      return { ok: false, status: viaPivot.status, error: viaPivot.error };
    }
    // The pivot speaks Responses; the client asked for Chat chunks. The
    // frames are translated on the way out.
    if (viaPivot.body) {
      const mapper = chatFrameMapper(chatReq.model);
      return {
        ok: true,
        status: 200,
        body: withSources(sseRewrite(viaPivot.body, {
          map: mapper.map,
          onEnd: mapper.onEnd,
          signal,
        }), sources),
        contentType: "text/event-stream; charset=utf-8",
      };
    }
    const data = responsesToChatResponse(viaPivot.data, chatReq);
    if (sources.length > 0) applyChatSearchAnnotations(data, sources);
    return {
      ok: true,
      status: 200,
      data,
    };
  }

  // A Chat Completions body, straight to a Chat Completions upstream.
  const direct = await proxyChatDirect({ req: chatReq, apiKey, user, signal, deps, provider });
  if (!direct.ok) return direct;
  if (sources.length > 0) {
    if (direct.data) applyChatSearchAnnotations(direct.data, sources);
    else if (direct.body) direct.body = withSources(direct.body, sources);
  }
  return direct;
}

/**
 * Put the sources on a stream, when there are any.
 *
 * A stream without sources is returned untouched: wrapping it for nothing
 * would change bytes the client did not ask to have changed.
 */
function withSources(
  body: ReadableStream<Uint8Array>,
  sources: WebSearchSource[],
): ReadableStream<Uint8Array> {
  if (sources.length === 0) return body;
  return withChatSearchAnnotationStream(body, sources);
}

/**
 * Answer the hosted web search tool, and put the results in front of the model.
 *
 * The search goes through the same settlement every other search goes
 * through, so the account is charged the same price it would have paid for a
 * search it had asked for itself.
 */
async function prepareHostedChatSearch(args: {
  req: ChatCompletionRequest;
  user: User;
  apiKey: ApiKey;
}): Promise<{ req: ChatCompletionRequest; sources: WebSearchSource[] } | { error: ProxyResult }> {
  const { req, user, apiKey } = args;
  const query = lastChatUserText(req.messages);
  if (!query) {
    return {
      error: {
        ok: false,
        status: 400,
        error: {
          code: "web_search_no_query",
          message: "web_search needs a question to search for",
        },
      },
    };
  }

  let settled;
  try {
    settled = await runBilledSearch({
      query,
      limit: chatSearchLimit(req.web_search_options),
      user,
      apiKeyId: apiKey.id,
    });
  } catch (err) {
    if (err instanceof WebSearchError) {
      // The client asked for a search and the deployment cannot search. Saying
      // so is the honest answer; answering as if it had searched would be a lie
      // the model would then tell the user.
      const http = searchErrorHttp(err.code);
      return {
        error: {
          ok: false,
          status: http.status,
          error: { code: http.code, message: err.message },
        },
      };
    }
    throw err;
  }

  const sources = sourcesFromResults(settled.outcome.results);
  // Nothing found is still an answer: the model is told the search found
  // nothing, and says so, rather than filling the gap from memory.
  const context = buildSearchContext(query, sources);
  const stripped = stripHostedSearchFields(req);
  return {
    req: {
      ...stripped,
      messages: withChatSearchContext(req.messages, context) as ChatCompletionRequest["messages"],
    },
    sources,
  };
}
