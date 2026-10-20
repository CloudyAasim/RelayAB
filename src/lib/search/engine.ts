/**
 * src/lib/search/engine.ts
 *
 * The generic executor for the search adapter protocol (`specVersion: 1`).
 *
 * Everything vendor-specific lives in a spec (see `./spec.ts`); this file only
 * knows how to *interpret* it. Adding a search vendor therefore means shipping
 * a JSON document, never a code change and never a redeploy — which is what
 * the media adapter protocol already does on the other side of this codebase,
 * and what the three hand-written adapters this replaced could not do.
 *
 * The contract the engine expects of a spec:
 *
 *   transport.method / path / query / body  → one HTTP request
 *   auth                                    → where the credential goes
 *   response.items                          → path to the array of hits
 *   response.fields                         → where each field of one hit lives
 *   limits.timeoutMs                        → the request deadline
 */
import { getPath, resolveTemplate } from "../spec/primitives";
import { plainText, usableUrl } from "./normalize";
import { readSearchField, type SearchSpec } from "./spec";
import {
  MAX_SEARCH_BYTES,
  MAX_SNIPPET_CHARS,
  MAX_TITLE_CHARS,
  SEARCH_TIMEOUT_MS,
  WebSearchError,
  type WebSearchResult,
} from "./types";

export interface BuiltSearchRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** Present for a POST. */
  body?: string;
}

export interface SearchExecutionArgs {
  query: string;
  limit: number;
  /** The credential, when the vendor needs one. */
  apiKey?: string;
  /** What to call the backend in an error message. */
  displayName: string;
  /**
   * What to tell an operator to check when the vendor refuses the credential.
   *
   * "the API key" is the right advice for a provider row and the wrong advice
   * for an environment variable, and the difference is the whole reason this
   * message is worth writing.
   */
  credentialHint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The values a template may fill in.
 *
 * Only these two. A spec that asks for a third one is refused at save time,
 * because a request that sends a literal `{{foo}}` upstream looks like a
 * search for the text `{{foo}}` and returns confidently wrong results.
 */
export function searchTemplateScope(args: { query: string; limit: number }): Record<string, unknown> {
  return { query: args.query, limit: args.limit };
}

/**
 * Resolve one request value.
 *
 * The rule is the media protocol's own, so the two protocols read a spec the
 * same way:
 *
 *   - `"$.limit"` — a path into the request scope. Keeps the **type** of what
 *     it resolves to, which is why a vendor's numeric field gets a number and
 *     not `"6"`.
 *   - `"{{…}}"` — a template. A value that is **exactly one** placeholder keeps
 *     the type of what it points at, for the same reason a path does: a vendor
 *     that documents a numeric field rejects the string form. A value with text
 *     around the placeholder is a string, because that is what it is.
 *   - anything else — a literal.
 *
 * The order matters: a string cannot start with both `$` and `{{`.
 *
 * **Nested values are resolved too.** A vendor that wants the query inside an
 * envelope (`{"opts": {"q": "…"}}`) is a vendor whose spec says so, and the
 * engine used to hand the nested object over untouched — which meant a
 * placeholder inside it reached the vendor as the literal text `{{$.query}}`.
 */
function resolveValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$")) return getPath(scope, value);
    const single = /^\{\{([^}]+)\}\}$/.exec(value);
    if (single) {
      const resolved = getPath(scope, single[1].trim());
      // A placeholder that resolves to nothing becomes an empty string, the
      // same rule the shared `resolveTemplate` follows.
      return resolved === undefined || resolved === null ? "" : resolved;
    }
    if (value.includes("{{")) return resolveTemplate(value, scope);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
      out[name] = resolveValue(entry, scope);
    }
    return out;
  }
  return value;
}

/**
 * Build the request a spec describes.
 *
 * The base address and the spec's `transport.path` are joined **by
 * concatenation**, not the way a URL is joined:
 *
 *   <服务根地址，去掉尾部斜杠> + <transport.path>
 *
 * So a base of `https://api.example.com/v1` with a path of `/search` asks for
 * `https://api.example.com/v1/search` — the base keeps its own path, and the
 * spec's path is appended to it. That is what the protocol document says, and
 * it is what lets an operator put a prefix in the address (`…/v1`) and have it
 * survive. A path does **not** replace the base's path.
 *
 * **An empty path means the address is the whole endpoint.** That is the rule
 * the rows written before the protocol existed are read under: a Tavily row's
 * address was the complete endpoint, and the old code sent it as it stood.
 * The engine used to turn the empty path into a `/` and sent
 * `https://api.tavily.com/search/` — one byte different from what the old
 * adapter sent, on every request, to every deployment that had a row written
 * before the protocol. It is fixed here, and the test that pins it is
 * `tests/unit/search-protocol.test.ts`.
 */
export function buildSearchRequest(
  spec: SearchSpec,
  baseUrl: string,
  args: { query: string; limit: number; apiKey?: string },
): BuiltSearchRequest {
  const scope = searchTemplateScope(args);
  const rawBase = baseUrl.trim();
  const rawPath = spec.transport.path ?? "";
  // The spec's own ceiling applies here, not only to the answer: a request
  // that asks for more than the vendor accepts is a request the vendor
  // refuses, and the field is the one place that says what it accepts.
  const limit = effectiveLimit(spec, args.limit);
  const scopeWithLimit = { ...scope, limit };

  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new WebSearchError(`搜索后端的地址不合法：${baseUrl}`, "not_configured");
  }
  if (url.search || url.hash) {
    // `https://host?x=1` + `/search` is `https://host?x=1/search` — the path
    // lands in the query string and the endpoint is silently lost. Refuse it
    // here rather than send a request to somewhere the operator did not mean.
    throw new WebSearchError(
      `搜索后端的地址不合法：${baseUrl}（地址里不能带 ?query 或 #fragment）`,
      "not_configured",
    );
  }
  if (rawPath) {
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    url = new URL(`${rawBase.replace(/\/+$/, "")}${path}`);
  }

  const headers: Record<string, string> = { ...(spec.transport.headers ?? {}) };
  const auth = spec.auth;
  const key = args.apiKey?.trim();

  if (auth && key) {
    switch (auth.type) {
      case "bearer":
        headers.authorization = `${auth.prefix ?? "Bearer "}${key}`;
        break;
      case "header":
        if (auth.name) headers[auth.name] = `${auth.prefix ?? ""}${key}`;
        break;
      case "query":
        if (auth.name) url.searchParams.set(auth.name, `${auth.prefix ?? ""}${key}`);
        break;
      case "none":
        break;
    }
  }

  for (const [name, value] of Object.entries(spec.transport.query ?? {})) {
    url.searchParams.set(name, String(resolveValue(value, scopeWithLimit) ?? ""));
  }

  let body: string | undefined;
  if (spec.transport.method === "POST") {
    const resolved: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(spec.transport.body ?? {})) {
      resolved[name] = resolveValue(value, scopeWithLimit);
    }
    body = JSON.stringify(resolved);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }

  return { url: url.toString(), method: spec.transport.method, headers, body };
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
      let aborted = false;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: Uint8Array }>((resolve) => {
          if (signal.aborted) {
            aborted = true;
            resolve({ done: true });
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({ done: true });
            },
            { once: true },
          );
        }),
      ]);
      if (chunk.done) {
        if (aborted) {
          /**
           * The deadline passed while the body was still arriving.
           *
           * Truncating here and handing back half a document would have the
           * caller report "the vendor did not answer with JSON" — blaming the
           * vendor for our timeout. The name is what `searchWeb` recognises
           * and turns into a "搜索超时".
           */
          const timeout = new Error("搜索超时");
          timeout.name = "TimeoutError";
          throw timeout;
        }
        break;
      }
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

/**
 * Read the hits out of the vendor's answer.
 *
 * Duplicates go, in the order the vendor listed them: a vendor that repeats a
 * result three ways is not offering the reader a choice.
 *
 * The list is **capped at the number that was asked for**. A vendor that does
 * not take a count — SearXNG, whose JSON output has no such parameter — will
 * happily answer with everything it has, and the caller asked for five.
 */
/**
 * The hits in a payload, or null when the answer was not the shape the spec
 * expects.
 *
 * The difference between "the vendor found nothing" and "the vendor answered
 * something else" is the difference between a working service and a wrong
 * address, and a caller that only sees an empty list cannot tell them apart.
 * So the two answers are kept apart here, and the probe reports which one it
 * got.
 */
export function readSearchItems(spec: SearchSpec, payload: unknown): unknown[] | null {
  const items = getPath(payload, spec.response.items);
  return Array.isArray(items) ? items : null;
}

export function parseSearchResults(spec: SearchSpec, payload: unknown, limit?: number): WebSearchResult[] {
  const items = readSearchItems(spec, payload);
  if (!items) return [];

  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const hit of items) {
    if (!hit || typeof hit !== "object") continue;
    const url = usableUrl(readSearchField(hit, spec.response.fields.url));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: plainText(readSearchField(hit, spec.response.fields.title), MAX_TITLE_CHARS) || url,
      url,
      snippet: plainText(readSearchField(hit, spec.response.fields.snippet), MAX_SNIPPET_CHARS),
    });
    if (typeof limit === "number" && out.length >= limit) break;
  }
  return out;
}

/**
 * Turn a provider's HTTP answer into a sentence the operator can act on.
 *
 * The generic "upstream returned HTTP 401" is the least useful thing to say to
 * someone who only needs to know which variable or provider record is wrong.
 */
async function checkedBody(
  res: Response,
  name: string,
  hint: string,
  signal: AbortSignal,
): Promise<string> {
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

/**
 * How many results this call may actually ask for.
 *
 * The caller's wish and the vendor's ceiling, and the ceiling wins: a spec
 * that says `limits.maxResults: 3` is saying "this vendor takes at most
 * three". Asking for six would have the vendor reject the request — and the
 * field would be one more thing that validates and then does nothing, which
 * is the exact failure this protocol exists to end.
 */
export function effectiveLimit(spec: SearchSpec, requested: number): number {
  const want = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : 1;
  const cap = spec.limits?.maxResults;
  return typeof cap === "number" && cap > 0 ? Math.min(want, cap) : want;
}

/**
 * What one search produced, and what the answer looked like.
 *
 * `shapeOk` is the part a caller needs and the results alone cannot carry:
 * an empty list from a service that answered with something else is not the
 * same thing as an empty list from a service that found nothing.
 */
export interface SearchExecutionReport {
  results: WebSearchResult[];
  /** Whether the answer carried the array the spec points at. */
  shapeOk: boolean;
  /** How many hits the answer carried, before the limit cut them. */
  itemCount: number;
}

/**
 * Run one search through a spec and report on the answer.
 *
 * The one place a search is actually performed. `executeSearch` below is the
 * same thing without the report, for callers that only want hits.
 */
export async function executeSearchWithReport(
  spec: SearchSpec,
  baseUrl: string,
  args: SearchExecutionArgs,
): Promise<SearchExecutionReport> {
  // Clamped before the request is built, not after the answer arrives: the
  // count the vendor is asked for and the count it is allowed to answer with
  // have to be the same number.
  const limit = effectiveLimit(spec, args.limit);
  const request = buildSearchRequest(spec, baseUrl, { ...args, limit });
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = spec.limits?.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const hint = args.credentialHint ?? "该提供商的 API 密钥";

  const res = await fetchImpl(request.url, {
    method: request.method,
    signal,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
  });

  const body = await checkedBody(res, args.displayName, hint, signal);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebSearchError(
      `${args.displayName} 返回的不是 JSON。它可能不是搜索接口，或者返回了一个错误页面。`,
      "upstream_error",
    );
  }

  const items = readSearchItems(spec, payload);
  return {
    results: parseSearchResults(spec, payload, limit),
    shapeOk: items !== null,
    itemCount: items?.length ?? 0,
  };
}

/**
 * Run one search through a spec.
 *
 * The whole of a vendor's wire behavior is here: build the request, send it,
 * read the answer, pull the hits out of it. Everything a vendor does
 * differently is in the spec.
 */
export async function executeSearch(
  spec: SearchSpec,
  baseUrl: string,
  args: SearchExecutionArgs,
): Promise<WebSearchResult[]> {
  const report = await executeSearchWithReport(spec, baseUrl, args);
  return report.results;
}
