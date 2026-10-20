/**
 * src/lib/search/templates.ts
 *
 * Ready-made specs for the vendors that ship with the gateway. These are
 * ordinary documents, not code: the admin panel can import, edit and re-export
 * them, which is exactly the workflow the protocol is meant to enable ("read
 * the vendor's docs, adjust the field names, done").
 *
 * ## Why these exist at all
 *
 * Before the protocol, these three vendors were three hand-written adapters in
 * `src/lib/assistant/web-search.ts`. Each had its own request builder and its
 * own response reader, and each hardcoded the parameters its API offers:
 * Tavily's `search_depth`, Brave's `search_lang`, SearXNG's `language` and
 * `safesearch`. A vendor's own options were reachable only by editing that
 * file and shipping a deploy.
 *
 * Now they are specs, and an operator who wants `search_depth: "advanced"`,
 * a different language, a freshness window, or a country edits one line in
 * the panel. Nothing is hardcoded here that a spec cannot change.
 *
 * ## The values are the ones that were in the code
 *
 * Every parameter below is the value the old adapter sent, unchanged — the
 * Chinese-first language, the safe-search setting, the result count. Changing
 * them here would change what a search returns for every deployment that
 * upgrades, and a deploy that quietly alters results is not a deploy anybody
 * asked for. They are *editable*, which is the point; they are not *different*.
 */
import type { SearchSpec } from "./spec";

export interface SearchTemplate {
  /** Stable id, used by the panel and by the drift check. */
  id: string;
  /** What the operator sees. */
  name: string;
  /** One line on what this backend is. */
  description: string;
  /** The spec a new row gets when this template is picked. */
  spec: SearchSpec;
  /**
   * Whether a row written **before** the protocol stored an address that
   * already included the endpoint path.
   *
   * The old code used a Tavily or Brave row's address as the *whole* endpoint
   * and a SearXNG row's address as the *service root*, with `/search` appended.
   * That difference was invisible and undocumented, and it is why a Tavily
   * address pasted into a Brave row was only discovered at request time.
   *
   * Rows that predate the protocol are still read the old way, so nothing that
   * works today breaks. Every row created from now on stores a spec, and a spec
   * has one meaning for the address: the service root.
   */
  legacyAddressIncludesPath: boolean;
}

/**
 * SearXNG — a self-hosted instance.
 *
 * The `language` and `safesearch` values are what the old adapter sent. They
 * are editable in the panel: a deployment that searches English sources, or
 * one that has to answer to a content policy, changes them there and the next
 * search uses the new values.
 */
export const SEARXNG_TEMPLATE: SearchTemplate = {
  id: "searxng",
  name: "SearXNG",
  description: "自建的 SearXNG 实例，需要在实例配置里开启 JSON 输出",
  legacyAddressIncludesPath: false,
  spec: {
    specVersion: 1,
    displayName: "SearXNG",
    vendor: "searxng",
    transport: {
      method: "GET",
      path: "/search",
      headers: { accept: "application/json" },
      query: {
        q: "$.query",
        format: "json",
        language: "zh-CN",
        safesearch: "0",
      },
    },
    // Optional: an instance behind a proxy may want the key, one on a private
    // network does not. `required: false` says so, and a missing key then
    // means no header at all — never an empty one.
    auth: { type: "header", name: "x-api-key", required: false },
    response: {
      items: "$.results",
      fields: {
        title: "$.title",
        url: "$.url",
        snippet: { $firstPresent: ["$.content", "$.snippet"] },
      },
    },
    limits: { timeoutMs: 15_000 },
  },
};

/**
 * Tavily — results tuned for LLMs.
 *
 * `search_depth: "basic"` is what the old adapter sent. Tavily's other depth
 * ("advanced") costs more per call, which is a decision for the operator and
 * not one this template makes.
 */
export const TAVILY_TEMPLATE: SearchTemplate = {
  id: "tavily",
  name: "Tavily",
  description: "Tavily 官方 API，结果偏向给大模型用",
  legacyAddressIncludesPath: true,
  spec: {
    specVersion: 1,
    displayName: "Tavily",
    vendor: "tavily",
    baseUrl: "https://api.tavily.com",
    transport: {
      method: "POST",
      path: "/search",
      headers: { "content-type": "application/json" },
      body: {
        query: "$.query",
        search_depth: "basic",
        max_results: "$.limit",
        include_answer: false,
        include_raw_content: false,
      },
    },
    auth: { type: "bearer" },
    response: {
      items: "$.results",
      fields: {
        title: "$.title",
        url: "$.url",
        snippet: { $firstPresent: ["$.content", "$.snippet"] },
      },
    },
    limits: { timeoutMs: 15_000 },
  },
};

/**
 * Brave Search.
 *
 * The language is asked for in Chinese because the docs answer in Chinese and
 * asking for Chinese results first is what puts `docs.bigmodel.cn` at the top
 * instead of an English mirror. It is a default, not a rule: the panel can
 * change it, and `country`, `freshness` and `safesearch` can be added beside
 * it — Brave's API documents all three, and none of them were reachable.
 */
export const BRAVE_TEMPLATE: SearchTemplate = {
  id: "brave",
  name: "Brave Search",
  description: "Brave 官方搜索 API",
  legacyAddressIncludesPath: true,
  spec: {
    specVersion: 1,
    displayName: "Brave Search",
    vendor: "brave",
    baseUrl: "https://api.search.brave.com",
    transport: {
      method: "GET",
      path: "/res/v1/web/search",
      headers: { accept: "application/json" },
      query: {
        q: "$.query",
        count: "$.limit",
        search_lang: "zh-hans",
      },
    },
    auth: { type: "header", name: "x-subscription-token" },
    response: {
      items: "$.web.results",
      fields: {
        title: "$.title",
        url: "$.url",
        snippet: { $firstPresent: ["$.description", "$.snippet"] },
      },
    },
    limits: { timeoutMs: 15_000 },
  },
};

/**
 * The OpenAI-compatible search shape.
 *
 * **The address is the whole endpoint** — the path is empty, so nothing is
 * appended to it. That is the rule the rows written before the protocol
 * existed are read under, and it is what a user pasting a search service's
 * documented URL expects: what they type is what gets called.
 *
 * The shape itself is the one this gateway already speaks on `/v1/search`:
 *
 *   POST <地址>
 *   Authorization: Bearer <密钥>
 *   Content-Type: application/json
 *
 *   {"query": "搜索词", "limit": 6}
 *
 *   → {"object": "search", "results": [{"title", "url", "snippet"}], …}
 *
 * So pointing the assistant at another instance of this gateway works with
 * nothing but its `/v1/search` address and a key, and so does any vendor that
 * publishes the same shape.
 *
 * **The key is optional here** (`auth.required: false`) and nowhere else: a
 * user may point the assistant at a service on their own machine that asks for
 * no credential, and a missing key must then mean "no credential is sent" —
 * never an empty `Authorization` header, which some servers read as a
 * malformed key rather than as no key.
 */
export const OPENAI_COMPATIBLE_TEMPLATE: SearchTemplate = {
  id: "openai-compatible",
  name: "OpenAI 兼容搜索",
  description:
    "任何说 OpenAI 兼容搜索形状的接口：POST 到你填的地址，Bearer 鉴权，{query, limit} 进，{results:[{title,url,snippet}]} 出",
  legacyAddressIncludesPath: true,
  spec: {
    specVersion: 1,
    displayName: "OpenAI 兼容搜索",
    vendor: "openai-compatible",
    transport: {
      method: "POST",
      // Empty on purpose: the address is the endpoint, and nothing is appended.
      path: "",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: { query: "$.query", limit: "$.limit" },
    },
    auth: { type: "bearer", required: false },
    response: {
      items: "$.results",
      fields: {
        title: "$.title",
        url: "$.url",
        // The three names the shape goes by, in the order they are tried.
        snippet: { $firstPresent: ["$.snippet", "$.content", "$.description"] },
      },
    },
    limits: { timeoutMs: 15_000 },
  },
};

export const SEARCH_TEMPLATES: readonly SearchTemplate[] = [
  SEARXNG_TEMPLATE,
  TAVILY_TEMPLATE,
  BRAVE_TEMPLATE,
  OPENAI_COMPATIBLE_TEMPLATE,
];

const BY_ID = new Map(SEARCH_TEMPLATES.map((template) => [template.id, template]));

export function searchTemplateById(id: string): SearchTemplate | null {
  return BY_ID.get(id) ?? null;
}

/** The template a provider row's `kind` names, when it names a known one. */
export function searchTemplateByKind(kind: string): SearchTemplate | null {
  return BY_ID.get(kind) ?? null;
}
