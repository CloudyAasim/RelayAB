/**
 * src/lib/search/types.ts
 *
 * The shapes the whole search subsystem agrees on.
 *
 * They live here rather than in `src/lib/assistant/web-search.ts` because that
 * file and the engine now sit on opposite sides of a dependency: the engine
 * must not import the module that imports the engine. Both import this one.
 */

/** One search hit, normalized across providers. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** The vendors that ship with a built-in template. */
export const BUILTIN_SEARCH_KINDS = ["tavily", "brave", "searxng", "openai-compatible"] as const;
export type BuiltinSearchKind = (typeof BUILTIN_SEARCH_KINDS)[number];

/**
 * Which vendor answered.
 *
 * Free text, not an enum: a provider row may carry its own spec and name any
 * vendor at all — that is the whole point of the protocol. The three built-ins
 * are a convenience, not a limit. (`string & {}` keeps the built-ins offered
 * by the editor while still allowing any other tag.)
 */
export type SearchProvider = BuiltinSearchKind | (string & {});

/** Results per search when the caller states no preference. */
export const MAX_SEARCH_RESULTS = 8;

/** Query length the providers accept; longer queries are refused up front. */
export const MAX_QUERY_CHARS = 400;

/** Request deadline when a spec does not state one. */
export const SEARCH_TIMEOUT_MS = 15_000;

/** An API answer larger than this is not a result list. */
export const MAX_SEARCH_BYTES = 2_000_000;

export const MAX_SNIPPET_CHARS = 320;
export const MAX_TITLE_CHARS = 200;

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "bad_key"
      | "rate_limited"
      | "upstream_error"
      | "unreachable"
      /**
       * The account cannot pay for this call.
       *
       * Its own code because it is the one failure that is not the vendor's
       * fault and not a configuration problem: the request is fine, the
       * balance is not, and the caller has to top up rather than retry.
       */
      | "quota_exceeded",
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}
