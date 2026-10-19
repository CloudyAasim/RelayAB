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
 */

/** One search hit, normalized across providers. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = "tavily" | "brave" | "searxng";

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
  /** Host shown back to the model, never the key. */
  describe: string;
  search(query: string, limit: number, fetchImpl: typeof fetch): Promise<WebSearchResult[]>;
}

export interface CreateSearchBackendInput {
  kind: SearchProvider;
  /** SearXNG's base address; for Tavily/Brave an optional full endpoint. */
  baseUrl?: string;
  apiKey?: string;
  /** Defaults to `kind`, which is what the environment path wants. */
  usageProviderId?: string;
  source?: "db" | "env";
  /** Operator-visible name; falls back to the vendor's own. */
  describe?: string;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "bad_key"
      | "rate_limited"
      | "upstream_error"
      | "unreachable",
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

const SEARCH_TIMEOUT_MS = 15_000;
/** An API answer larger than this is not a result list. */
const MAX_SEARCH_BYTES = 2_000_000;
const MAX_SNIPPET_CHARS = 320;
const MAX_TITLE_CHARS = 200;
export const MAX_SEARCH_RESULTS = 8;

/** Query length the providers accept; longer queries are refused up front. */
export const MAX_QUERY_CHARS = 400;

// ---------------------------------------------------------------------------
// Reading and normalizing
// ---------------------------------------------------------------------------

function decodeEntities(value: string): string {
  const table: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
    "&mdash;": "—",
    "&ndash;": "–",
    "&hellip;": "…",
  };
  return value.replace(/&[a-z#0-9]+;/gi, (m) => table[m.toLowerCase()] ?? " ");
}

/** Titles and descriptions arrive with markup often enough to matter. */
function plainText(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/**
 * Read a response body under both a byte cap and the request deadline.
 *
 * `res.text()` alone is not enough: the abort signal passed to `fetch` covers
 * the connection, not a body that has already started arriving — the same
 * shape that once let a `fetch_page` call sit open indefinitely. Racing the
 * reader against the signal is what actually enforces the timeout.
 */
async function readCapped(res: Response, signal: AbortSignal, cap = MAX_SEARCH_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: Uint8Array }>((resolve) => {
          if (signal.aborted) {
            resolve({ done: true });
            return;
          }
          signal.addEventListener("abort", () => resolve({ done: true }), { once: true });
        }),
      ]);
      if (chunk.done) break;
      const value = chunk.value!;
      const room = cap - bytes;
      if (room <= 0) break;
      const take = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += take.byteLength;
      out += decoder.decode(take, { stream: true });
      if (bytes >= cap) break;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out;
}

/** A result URL worth handing to `fetch_page` — and nothing else. */
function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Dedupe by URL, keep order, drop anything without a destination. */
function normalize(
  raw: unknown,
  pick: (entry: Record<string, unknown>) => WebSearchResult,
): WebSearchResult[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const result = pick(entry as Record<string, unknown>);
    const url = usableUrl(result.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: plainText(result.title, MAX_TITLE_CHARS) || url,
      url,
      snippet: plainText(result.snippet, MAX_SNIPPET_CHARS),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Build a backend from a provider row or from the environment.
 *
 * One factory for both sources, so the wire behavior of a SearXNG instance
 * cannot depend on whether an operator typed it into the panel or set
 * `SEARXNG_URL`. Returns null when the configuration cannot possibly work — a
 * missing key, a missing address, a non-http address — which the resolver uses
 * to skip an unusable row rather than fail a search with a vague error.
 */
export function createSearchBackend(input: CreateSearchBackendInput): SearchBackend | null {
  const source = input.source ?? "env";
  const usageProviderId = input.usageProviderId ?? input.kind;
  const describe = input.describe?.trim() || null;

  const base = {
    usageProviderId,
    source,
    ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
  };

  if (input.kind === "tavily") {
    const key = input.apiKey?.trim();
    if (!key) return null;
    const name = describe ?? "Tavily";
    const endpoint = input.baseUrl?.trim() || "https://api.tavily.com/search";
    return {
      ...base,
      provider: "tavily",
      describe: name,
      async search(query, limit, fetchImpl) {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            max_results: limit,
            include_answer: false,
            include_raw_content: false,
          }),
        });
        const body = await checkedBody(
          res,
          name,
          source === "env" ? "TAVILY_API_KEY" : "该提供商的 API 密钥",
        );
        const data = JSON.parse(body) as { results?: unknown };
        return normalize(data.results, (entry) => ({
          title: String(entry.title ?? ""),
          url: String(entry.url ?? ""),
          snippet: String(entry.content ?? entry.snippet ?? ""),
        })).slice(0, limit);
      },
    };
  }

  if (input.kind === "brave") {
    const key = input.apiKey?.trim();
    if (!key) return null;
    const name = describe ?? "Brave Search";
    const endpoint = input.baseUrl?.trim() || "https://api.search.brave.com/res/v1/web/search";
    return {
      ...base,
      provider: "brave",
      describe: name,
      async search(query, limit, fetchImpl) {
        const url = new URL(endpoint);
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(limit));
        // The docs answer in Chinese; asking for Chinese results first is what
        // puts docs.bigmodel.cn at the top instead of an English mirror.
        url.searchParams.set("search_lang", "zh-hans");
        const res = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
          headers: {
            accept: "application/json",
            "x-subscription-token": key,
          },
        });
        const body = await checkedBody(
          res,
          name,
          source === "env" ? "BRAVE_SEARCH_API_KEY" : "该提供商的 API 密钥",
        );
        const data = JSON.parse(body) as { web?: { results?: unknown } };
        return normalize(data.web?.results, (entry) => ({
          title: String(entry.title ?? ""),
          url: String(entry.url ?? ""),
          snippet: String(entry.description ?? ""),
        })).slice(0, limit);
      },
    };
  }

  const searxBase = input.baseUrl?.trim();
  if (!searxBase) return null;
  try {
    const parsed = new URL(searxBase);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const name = describe ?? "SearXNG";
  const apiKey = input.apiKey?.trim();
  return {
    ...base,
    baseUrl: searxBase,
    provider: "searxng",
    describe: name,
    async search(query, limit, fetchImpl) {
      const url = new URL("search", searxBase.endsWith("/") ? searxBase : `${searxBase}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", "zh-CN");
      url.searchParams.set("safesearch", "0");
      const res = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
      });
      const body = await checkedBody(
        res,
        name,
        source === "env" ? "SEARXNG_URL / SEARXNG_API_KEY" : "该提供商的配置",
      );
      const data = JSON.parse(body) as { results?: unknown };
      return normalize(data.results, (entry) => ({
        title: String(entry.title ?? ""),
        url: String(entry.url ?? ""),
        snippet: String(entry.content ?? entry.snippet ?? ""),
      })).slice(0, limit);
    },
  };
}

/**
 * Turn a provider's HTTP answer into a sentence the operator can act on.
 *
 * The generic "upstream returned HTTP 401" is the least useful thing to say to
 * someone who only needs to know which variable or provider record is wrong.
 */
async function checkedBody(res: Response, name: string, hint: string): Promise<string> {
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new WebSearchError(
      `${name} 拒绝了访问（HTTP ${res.status}）。请检查 ${hint} 是否正确、是否已启用。`,
      "bad_key",
    );
  }
  if (res.status === 429) {
    throw new WebSearchError(`${name} 限流了（HTTP 429），稍后再试，或检查套餐额度。`, "rate_limited");
  }
  if (!res.ok) {
    throw new WebSearchError(`${name} 返回了 HTTP ${res.status}。`, "upstream_error");
  }
  const body = await readCapped(res, signal);
  if (!body.trim()) throw new WebSearchError(`${name} 返回了空响应。`, "upstream_error");
  return body;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The backend the operator configured, or null.
 *
 * Exported so the tool can say "no backend" before spending a call, and so a
 * test can check the precedence without going near the network.
 */
export function resolveSearchBackend(env: NodeJS.ProcessEnv = process.env): SearchBackend | null {
  const tavilyKey = env.TAVILY_API_KEY?.trim();
  if (tavilyKey) return createSearchBackend({ kind: "tavily", apiKey: tavilyKey });

  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) return createSearchBackend({ kind: "brave", apiKey: braveKey });

  const searxBase = env.SEARXNG_URL?.trim();
  if (searxBase) {
    return createSearchBackend({
      kind: "searxng",
      baseUrl: searxBase,
      apiKey: env.SEARXNG_API_KEY?.trim() || undefined,
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
      throw new WebSearchError(
        `搜索超时（${Math.round(SEARCH_TIMEOUT_MS / 1000)} 秒），${backend.describe} 没有及时回答。`,
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
