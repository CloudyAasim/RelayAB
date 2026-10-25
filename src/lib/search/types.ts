/**
 * src/lib/search/types.ts
 *
 * The shapes the whole search subsystem agrees on.
 *
 * They live here rather than in `src/lib/assistant/web-search.ts` because that
 * file and the engine now sit on opposite sides of a dependency: the engine
 * must not import the module that imports the engine. Both import this one.
 */

/**
 * One search hit, normalized across providers.
 *
 * The first three are always there. The rest are **what the vendor
 * answered** — a relay cannot invent them, so a vendor that returns no
 * relevance score leaves the field out rather than making one up.
 *
 * The two text lengths exist because a search answer has two audiences: a
 * screen wants a short line, a model wants a paragraph it can read and
 * quote. Carrying only the short one is why an assistant ends up writing
 * an answer with nothing but titles to go on.
 */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** The vendor's longer text, for a model to read. */
  summary?: string;
  /** The page body, when the vendor returned one. */
  content?: string;
  /** The vendor's own relevance score, on the vendor's own scale. */
  score?: number;
  /** When the result was published, as the vendor wrote it. */
  date?: string;
  /** The site the result came from, when the vendor names it. */
  siteName?: string;
}

/** How much of the vendor's longer text to keep. */
export const MAX_SUMMARY_CHARS = 1_000;

/**
 * How much of a page body to keep.
 *
 * A body is the one field here that can be arbitrarily large, and a search
 * answer that carries a hundred kilobytes of page text is a response nobody
 * can read and a token bill nobody wants. The fetch endpoint is the way to
 * ask for a whole page.
 */
export const MAX_CONTENT_CHARS = 8_000;

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

/**
 * The HTTP status and the error code a search failure becomes.
 *
 * One place, because the failure reaches the caller through more than one
 * door — the public endpoint, the chat proxy answering a hosted search — and
 * a door that answered "503, the search is broken" for a request that was
 * merely too expensive to run would be telling the client to retry something
 * that will never succeed.
 */
export function searchErrorHttp(code: WebSearchError["code"]): { status: number; code: string } {
  switch (code) {
    // The deployment is missing a backend, not failing at a request: nothing
    // about the request was wrong, and it may work later.
    case "not_configured":
      return { status: 503, code: "search_unavailable" };
    case "bad_key":
      return { status: 502, code: "search_auth_failed" };
    case "rate_limited":
      return { status: 429, code: "rate_limited" };
    case "upstream_error":
      return { status: 502, code: "search_upstream_error" };
    case "unreachable":
      return { status: 502, code: "search_unreachable" };
    // The request was fine and the balance was not: top up rather than retry.
    case "quota_exceeded":
      return { status: 429, code: "quota_exceeded_credits" };
  }
}
