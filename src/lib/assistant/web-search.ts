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
  /** Host shown back to the model, never the key. */
  describe: string;
  search(query: string, limit: number, fetchImpl: typeof fetch): Promise<WebSearchResult[]>;
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

function tavily(key: string): SearchBackend {
  return {
    provider: "tavily",
    describe: "Tavily",
    async search(query, limit, fetchImpl) {
      const res = await fetchImpl("https://api.tavily.com/search", {
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
      const body = await checkedBody(res, "Tavily", "TAVILY_API_KEY");
      const data = JSON.parse(body) as { results?: unknown };
      return normalize(data.results, (entry) => ({
        title: String(entry.title ?? ""),
        url: String(entry.url ?? ""),
        snippet: String(entry.content ?? entry.snippet ?? ""),
      })).slice(0, limit);
    },
  };
}

function brave(key: string): SearchBackend {
  return {
    provider: "brave",
    describe: "Brave Search",
    async search(query, limit, fetchImpl) {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
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
      const body = await checkedBody(res, "Brave", "BRAVE_SEARCH_API_KEY");
      const data = JSON.parse(body) as { web?: { results?: unknown } };
      return normalize(data.web?.results, (entry) => ({
        title: String(entry.title ?? ""),
        url: String(entry.url ?? ""),
        snippet: String(entry.description ?? ""),
      })).slice(0, limit);
    },
  };
}

function searxng(baseUrl: string, apiKey?: string): SearchBackend {
  return {
    provider: "searxng",
    describe: "SearXNG",
    async search(query, limit, fetchImpl) {
      const url = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
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
      const body = await checkedBody(res, "SearXNG", "SEARXNG_URL");
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
 * someone who only needs to know which variable is wrong.
 */
async function checkedBody(res: Response, name: string, envVar: string): Promise<string> {
  const signal = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  if (res.status === 401 || res.status === 403) {
    throw new WebSearchError(
      `${name} 拒绝了密钥（HTTP ${res.status}）。请检查 ${envVar} 是否正确、是否已启用。`,
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
  if (tavilyKey) return tavily(tavilyKey);

  const braveKey = env.BRAVE_SEARCH_API_KEY?.trim();
  if (braveKey) return brave(braveKey);

  const searxBase = env.SEARXNG_URL?.trim();
  if (searxBase) {
    try {
      const url = new URL(searxBase);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    } catch {
      return null;
    }
    return searxng(searxBase, env.SEARXNG_API_KEY?.trim() || undefined);
  }
  return null;
}

export interface SearchOutcome {
  provider: SearchProvider;
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
  opts: { limit?: number; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<SearchOutcome> {
  const query = rawQuery.trim();
  if (!query) throw new WebSearchError("搜索词是空的。", "upstream_error");
  if (query.length > MAX_QUERY_CHARS) {
    throw new WebSearchError(`搜索词太长（${query.length} 字符），请控制在 ${MAX_QUERY_CHARS} 以内。`, "upstream_error");
  }

  const backend = resolveSearchBackend(opts.env);
  if (!backend) {
    throw new WebSearchError(
      "没有配置搜索后端。请设置 TAVILY_API_KEY、BRAVE_SEARCH_API_KEY 或 SEARXNG_URL 之一" +
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

  return { provider: backend.provider, backend: backend.describe, query, results };
}
