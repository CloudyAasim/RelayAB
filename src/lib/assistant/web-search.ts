/**
 * src/lib/assistant/web-search.ts
 *
 * Search the public web on the assistant's behalf.
 *
 * `fetch_page` can read a URL the model already knows, and that was the whole
 * problem: a model that does not know a vendor's documentation address can
 * only (a) recall one, which is exactly how an invented `base_url` happens, or
 * (b) ask the user, which turns a research question into homework. A search
 * step is the missing first half.
 *
 * **There is no keyless backend here on purpose.** The obvious candidates were
 * measured, not assumed: DuckDuckGo's HTML endpoints do not answer from this
 * network at all, Bing's answer to a URL-encoded Chinese query came back as
 * results for the single character `智`, and Mojeek answered a captcha page.
 * A scraper that silently degrades into "no results" is worse than a clear
 * "not configured", because the model would then report a false negative as
 * fact. So this speaks three documented APIs and says exactly what to set:
 *
 *   TAVILY_API_KEY        — https://tavily.com (results tuned for LLMs)
 *   BRAVE_SEARCH_API_KEY  — https://brave.com/search/api
 *   SEARXNG_URL           — a self-hosted instance with the JSON API enabled
 *
 * The first one configured wins, in that order. SearXNG is last because it is
 * the only one whose quality depends on the operator's instance.
 *
 * ## What changed, and why it is not a rewrite
 *
 * This file used to hold three hand-written adapters, one per vendor, each
 * with its own request builder and its own response reader. They are now
 * **specs** (`src/lib/search/templates.ts`) executed by one generic engine
 * (`src/lib/search/engine.ts`), which is the same arrangement the media
 * providers on the other side of this codebase use.
 *
 * The reason is consistency, and it is not a cosmetic one: a vendor's own
 * options — a different language, a freshness window, a country, a deeper
 * search — used to be unreachable without editing this file and shipping a
 * deploy. Now they are fields in a spec, editable in the panel.
 *
 * The request each vendor receives is unchanged, and that is pinned by a test
 * rather than by this comment.
 */
import { executeSearch } from "@/lib/search/engine";
import type { SearchSpec } from "@/lib/search/spec";
import {
  SEARXNG_TEMPLATE,
  TAVILY_TEMPLATE,
  BRAVE_TEMPLATE,
} from "@/lib/search/templates";
import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  SEARCH_TIMEOUT_MS,
  WebSearchError,
  type SearchProvider,
  type WebSearchResult,
} from "@/lib/search/types";

export { MAX_QUERY_CHARS, MAX_SEARCH_RESULTS, WebSearchError };
export type { SearchProvider, WebSearchResult };

export interface SearchBackend {
  provider: SearchProvider;
  /**
   * What to write into `usage_logs.provider_id`.
   *
   * A database row uses its own id, so a usage row points at the exact provider
   * that served the call. An environment backend uses its kind, which is also
   * what rows written before providers existed contain.
   */
  usageProviderId: string;
  /** Whether this came from the provider table or the environment fallback. */
  source: "db" | "env";
  /** The internal address, when the kind has one worth showing (SearXNG). */
  baseUrl?: string;
  /**
   * What one call costs, when the backend itself says so.
   *
   * Only a database provider carries a price: the environment fallback has no
   * row to hold one, and keeps using the feature-wide setting.
   */
  creditsPerCall?: number;
  /** Host shown back to the model, never the key. */
  describe: string;
  /** The spec this backend speaks. */
  spec: SearchSpec;
  /** The service root the spec's path is appended to. */
  endpointBase: string;
  /** The credential, when the vendor needs one. */
  apiKey?: string;
  /** What to tell an operator to check when the vendor refuses the credential. */
  credentialHint?: string;
  search(query: string, limit: number, fetchImpl: typeof fetch): Promise<WebSearchResult[]>;
}

export interface CreateSearchBackendInput {
  /** What to talk to, and how. */
  spec: SearchSpec;
  /** The service root. Overrides the spec's own default. */
  baseUrl?: string;
  /**
   * The address the **operator** chose, when they chose one.
   *
   * Separate from the effective address because the two answer different
   * questions. The effective address is where the request goes; the operator's
   * is one worth showing an administrator — a self-hosted instance's internal
   * hostname, a proxy's address. A vendor's own public default is not worth
   * showing, and putting it on screen would only be noise.
   */
  operatorAddress?: string;
  apiKey?: string;
  /** Defaults to the spec's vendor, which is what the environment path wants. */
  usageProviderId?: string;
  /**
   * The vendor's name, as it appears in usage rows.
   *
   * Separate from `usageProviderId` on purpose: a database row's usage id is
   * the row's own id, so that a usage line points at the exact provider that
   * served it — but the *vendor* is still what the operator calls the service.
   */
  provider?: string;
  source?: "db" | "env";
  /** Operator-visible name; falls back to the spec's own. */
  describe?: string;
  /** Per-call price, when this backend came from a provider row. */
  creditsPerCall?: number;
  /** What to check when the vendor refuses the credential. */
  credentialHint?: string;
}

/**
 * Build a backend from a spec.
 *
 * One factory for both sources — a provider row and an environment variable —
 * so the wire behavior of a SearXNG instance cannot depend on whether an
 * operator typed it into the panel or set `SEARXNG_URL`.
 *
 * Returns null when the configuration cannot possibly work: no address, an
 * address that is not http(s), or a vendor that needs a credential and has
 * none. The resolver uses that to skip an unusable row rather than fail every
 * search with a vague error.
 */
export function createSearchBackend(input: CreateSearchBackendInput): SearchBackend | null {
  const source = input.source ?? "env";
  const spec = input.spec;
  const endpointBase = (input.baseUrl?.trim() || spec.baseUrl?.trim() || "").trim();
  if (!endpointBase) return null;
  if (!isHttpAddress(endpointBase)) return null;

  const apiKey = input.apiKey?.trim();
  const auth = spec.auth;
  // A vendor that cannot answer without a credential is not a backend without
  // one. The one exception is a spec that says the credential is optional —
  // a self-hosted instance on a private network.
  if (auth && auth.type !== "none" && auth.required !== false && !apiKey) return null;

  const usageProviderId = input.usageProviderId ?? spec.vendor ?? "search";
  const describe = input.describe?.trim() || spec.displayName?.trim() || spec.vendor || "搜索后端";
  const operatorAddress = input.operatorAddress?.trim() || undefined;

  return {
    provider: (input.provider ?? spec.vendor ?? usageProviderId) as SearchProvider,
    usageProviderId,
    source,
    ...(operatorAddress ? { baseUrl: operatorAddress } : {}),
    ...(input.creditsPerCall !== undefined ? { creditsPerCall: input.creditsPerCall } : {}),
    describe,
    spec,
    endpointBase,
    ...(apiKey ? { apiKey } : {}),
    credentialHint: input.credentialHint,
    async search(query, limit, fetchImpl) {
      return executeSearch(spec, endpointBase, {
        query,
        limit,
        apiKey,
        displayName: describe,
        ...(input.credentialHint ? { credentialHint: input.credentialHint } : {}),
        fetchImpl,
      });
    },
  };
}

/** An address a request can actually be sent to. */
function isHttpAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The backend the operator configured, or null.
 *
 * Exported so the tool can say "no backend" before spending a call, and so a
 * test can check the precedence without going near the network.
 */
export function resolveSearchBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend | null {
  const tavilyKey = env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    return createSearchBackend({
      spec: TAVILY_TEMPLATE.spec,
      apiKey: tavilyKey,
      source: "env",
      usageProviderId: "tavily",
      describe: "Tavily",
      credentialHint: "TAVILY_API_KEY",
    });
  }

  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) {
    return createSearchBackend({
      spec: BRAVE_TEMPLATE.spec,
      apiKey: braveKey,
      source: "env",
      usageProviderId: "brave",
      describe: "Brave Search",
      credentialHint: "BRAVE_SEARCH_API_KEY",
    });
  }

  const searxBase = env.SEARXNG_URL?.trim();
  if (searxBase) {
    return createSearchBackend({
      spec: SEARXNG_TEMPLATE.spec,
      baseUrl: searxBase,
      // A self-hosted instance is the operator's own address, so it is worth
      // showing an administrator — the public vendors' defaults are not.
      operatorAddress: searxBase,
      apiKey: env.SEARXNG_API_KEY?.trim() || undefined,
      source: "env",
      usageProviderId: "searxng",
      describe: "SearXNG",
      credentialHint: "SEARXNG_URL / SEARXNG_API_KEY",
    });
  }
  return null;
}

export interface SearchOutcome {
  provider: SearchProvider;
  /** What the usage row should attribute this call to. */
  providerId: string;
  /** Human-readable backend name, safe to show. */
  backend: string;
  query: string;
  results: WebSearchResult[];
}

/**
 * Run a search, or explain why it cannot run.
 *
 * The query is a string, not a URL: no part of it reaches the network as an
 * address the model chose, so this path has none of `fetch_page`'s SSRF surface.
 */
export async function searchWeb(
  rawQuery: string,
  opts: {
    limit?: number;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    /**
     * A backend already chosen by the resolver (database providers first).
     *
     * When present it wins; when absent the environment path is used, which is
     * what keeps existing deployments and the unit tests working unchanged.
     */
    backend?: SearchBackend;
  } = {},
): Promise<SearchOutcome> {
  const query = rawQuery.trim();
  if (!query) throw new WebSearchError("搜索词是空的。", "upstream_error");
  if (query.length > MAX_QUERY_CHARS) {
    throw new WebSearchError(`搜索词太长（${query.length} 字符），请控制在 ${MAX_QUERY_CHARS} 以内。`, "upstream_error");
  }

  const backend = opts.backend ?? resolveSearchBackend(opts.env);
  if (!backend) {
    throw new WebSearchError(
      "没有可用的搜索后端。请到「管理 → 网页搜索」添加一个提供商，" +
        "或在环境变量里设置 TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / SEARXNG_URL" +
        "（SearXNG 需要开启 JSON 输出）。没配置之前不要声称自己「搜索过」。",
      "not_configured",
    );
  }

  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 6), 1), MAX_SEARCH_RESULTS);
  const fetchImpl = opts.fetchImpl ?? fetch;

  let results: WebSearchResult[];
  try {
    results = await backend.search(query, limit, fetchImpl);
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    if (err instanceof Error && err.name === "TimeoutError") {
      const timeoutMs = backend.spec.limits?.timeoutMs ?? SEARCH_TIMEOUT_MS;
      throw new WebSearchError(
        `搜索超时（${Math.round(timeoutMs / 1000)} 秒），${backend.describe} 没有及时回答。`,
        "unreachable",
      );
    }
    throw new WebSearchError(
      `连不上 ${backend.describe}：${err instanceof Error ? err.message : String(err)}`,
      "unreachable",
    );
  }

  return {
    provider: backend.provider,
    providerId: backend.usageProviderId,
    backend: backend.describe,
    query,
    results,
  };
}
