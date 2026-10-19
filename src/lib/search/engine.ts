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
 *   - `"{{…}}"` — a template, always a string.
 *   - anything else — a literal.
 *
 * The order matters: a string cannot start with both `$` and `{{`.
 */
function resolveValue(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  if (value.startsWith("$")) return getPath(scope, value);
  if (value.includes("{{")) return resolveTemplate(value, scope);
  return value;
}

/**
 * Build the request a spec describes.
 *
 * The base address and the spec's `transport.path` are joined the way a URL is
 * joined, not the way strings are concatenated: the path is absolute (it
 * starts with `/`), so it replaces whatever the base address had after the
 * host. A base address of `https://api.example.com/v1` with the path `/search`
 * asks for `https://api.example.com/search` — and that is deliberate, because
 * the base address is the *service root*, and the path says where the service
 * keeps its search endpoint. A vendor that hangs its search endpoint under a
 * prefix says so in the path.
 */
export function buildSearchRequest(
  spec: SearchSpec,
  baseUrl: string,
  args: { query: string; limit: number; apiKey?: string },
): BuiltSearchRequest {
  const scope = searchTemplateScope(args);
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const path = spec.transport.path.startsWith("/") ? spec.transport.path : `/${spec.transport.path}`;

  let url: URL;
  try {
    url = new URL(`${trimmedBase}${path}`);
  } catch {
    throw new WebSearchError(`搜索后端的地址不合法：${baseUrl}`, "not_configured");
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
    url.searchParams.set(name, String(resolveValue(value, scope) ?? ""));
  }

  let body: string | undefined;
  if (spec.transport.method === "POST") {
    const resolved: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(spec.transport.body ?? {})) {
      resolved[name] = resolveValue(value, scope);
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

/**
 * Read the hits out of the vendor's answer.
 *
 * Duplicates go, in the order the vendor listed them: a vendor that repeats a
 * result three ways is not offering the reader a choice.
 */
export function parseSearchResults(spec: SearchSpec, payload: unknown): WebSearchResult[] {
  const items = getPath(payload, spec.response.items);
  if (!Array.isArray(items)) return [];

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
  const request = buildSearchRequest(spec, baseUrl, args);
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

  return parseSearchResults(spec, payload);
}
