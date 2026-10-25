/**
 * src/lib/proxy/responses.ts
 *
 * The OpenAI Responses **client** surface.
 *
 * The request is checked and a row is picked; the pivot then reaches that
 * row in whichever dialect it speaks.
 */

import { checkKeyStatus, reasonToHttp } from "../auth/apikey";
import { shouldRejectBeforeRequest } from "../quota/calculator";
import { findOpenAIProvidersForModel } from "../db/providers";
import { providerFaces, type ApiKey, type User } from "../db/types";
import type { ProxyDeps, ProxyResult, ResponseAPIRequest } from "./types";
import { proxyResponsesViaDialect } from "./pivot";
import { runBilledSearch } from "../search/billing";
import { WebSearchError } from "../assistant/web-search";
import { searchErrorHttp } from "../search/types";
import {
  applySearchAnnotations,
  buildSearchContext,
  lastUserText,
  sourcesFromResults,
  stripHostedSearchFields,
  wantsHostedWebSearch,
  withSearchContext,
  type WebSearchSource,
} from "./web-search-tool";

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

/**
 * Forward an OpenAI Responses API request.
 * Maps to upstream /v1/responses endpoint.
 */
export async function proxyOpenAIResponse(args: {
  req: ResponseAPIRequest;
  apiKey: ApiKey;
  user: User;
  /** Incoming request signal — streams settle their usage when it aborts. */
  signal?: AbortSignal;
  deps?: ProxyDeps;
}): Promise<ProxyResult> {
  const { apiKey, user, signal, deps } = args;
  /** The request as it will go upstream — the search may add to it. */
  let req = args.req;

  if (!req.model) {
    return { ok: false, status: 400, error: { code: "missing_model", message: "model is required" } };
  }

  // 1. Validate key
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

  // 2. Pick the provider and honour the protocol it was configured with.
  //
  // One protocol, no automatic switching: if a vendor was declared as speaking
  // Chat Completions, the request goes out as Chat Completions and a failure is
  // reported as a failure. Silently retrying over a different protocol hides
  // real breakage (and paid for a doomed round trip on every request).
  const providers = await findOpenAIProvidersForModel(req.model);
  if (providers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { code: "model_not_mapped", message: `No provider configured for model '${req.model}'` },
    };
  }
  const provider = providers[0];

  /**
   * The hosted web search tool, when the upstream cannot forward it.
   *
   * A Responses-native upstream is given the tool as it stands: it knows the
   * tool, it searches, and it bills the account for the search it did. A
   * converted dialect cannot forward it — there is no such thing in the shape
   * it speaks — so the gateway answers it here.
   */
  const format = providerFaces(provider).openai?.format;
  const converted = format === "chat" || format === "anthropic" || format === "gemini";
  let sources: WebSearchSource[] = [];
  if (converted && wantsHostedWebSearch(req.tools)) {
    const prepared = await prepareHostedWebSearch({ req, user, apiKey });
    if ("error" in prepared) return prepared.error;
    req = prepared.req;
    sources = prepared.sources;
  }

  const result = await proxyResponsesViaDialect({ req, provider, apiKey, user, signal, deps });

  // The sources go on the answer, so a client that renders citations has
  // something to render.
  if (sources.length > 0 && result.ok && result.data) {
    applySearchAnnotations(result.data, sources);
  }
  return result;
}

/**
 * Answer the hosted web search tool, and put the results in front of the model.
 *
 * The search goes through the same settlement every other search goes
 * through, so the account is charged the same price it would have paid for a
 * search it had asked for itself.
 */
async function prepareHostedWebSearch(args: {
  req: ResponseAPIRequest;
  user: User;
  apiKey: ApiKey;
}): Promise<
  { req: ResponseAPIRequest; sources: WebSearchSource[] } | { error: ProxyResult }
> {
  const { req, user, apiKey } = args;
  const query = lastUserText(req.input);
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
    settled = await runBilledSearch({ query, limit: 6, user, apiKeyId: apiKey.id });
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
  return {
    // The tool is taken out of the request: the deployment did the searching,
    // and an upstream that is handed a `web_search` tool it cannot run would
    // refuse the whole request.
    req: stripHostedSearchFields({ ...req, input: withSearchContext(req.input, context) }),
    sources,
  };
}
