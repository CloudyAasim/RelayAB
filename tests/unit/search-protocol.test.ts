/**
 * tests/unit/search-protocol.test.ts
 *
 * The search adapter protocol.
 *
 * ## What this file is really about
 *
 * The three search backends used to be three hand-written adapters. They are
 * now specs executed by one generic engine, and the question that file has to
 * answer is the one the migration cannot afford to get wrong:
 *
 * > **Does a request still go where it used to go?**
 *
 * So the first section pins the exact request each vendor receives — method,
 * URL, headers, body — against values written out by hand from the old
 * adapters. Those are not snapshots of the new code; they are the old
 * behaviour, transcribed. If a change to the engine moves a request, this
 * file fails, and the failure names the vendor.
 *
 * The rest of the file covers the protocol itself: what it accepts, what it
 * refuses, how a stored row is read, and how a stored spec is compared to the
 * template it came from.
 */
import { describe, it, expect } from "vitest";

import { parseSearchSpec, validateSearchSpec } from "@/lib/search/spec";
import { buildSearchRequest, executeSearch, parseSearchResults } from "@/lib/search/engine";
import {
  BRAVE_TEMPLATE,
  SEARCH_TEMPLATES,
  SEARXNG_TEMPLATE,
  TAVILY_TEMPLATE,
  searchTemplateByKind,
} from "@/lib/search/templates";
import { effectiveEndpoint, effectiveSearchConfig } from "@/lib/search/effective";
import { specDrift } from "@/lib/search/drift";

// ---------------------------------------------------------------------------
// 1. The request each vendor receives
// ---------------------------------------------------------------------------

/**
 * What the old adapters sent, transcribed.
 *
 * These are the values from the three hand-written adapters in
 * `src/lib/assistant/web-search.ts` before the protocol existed.
 */
const LEGACY_REQUESTS = {
  tavily: {
    method: "POST",
    url: "https://api.tavily.com/search",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: {
      query: "vendor api",
      search_depth: "basic",
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
    },
  },
  brave: {
    method: "GET",
    url: "https://api.search.brave.com/res/v1/web/search?q=vendor+api&count=6&search_lang=zh-hans",
    headers: { accept: "application/json", "x-subscription-token": "secret" },
  },
  searxng: {
    method: "GET",
    url: "http://relay-search.web:8080/search?q=vendor+api&format=json&language=zh-CN&safesearch=0",
    headers: { accept: "application/json" },
  },
} as const;

describe("the request each vendor receives is the one it used to receive", () => {
  it("Tavily", () => {
    const request = buildSearchRequest(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
      query: "vendor api",
      limit: 6,
      apiKey: "secret",
    });
    expect(request.method).toBe(LEGACY_REQUESTS.tavily.method);
    expect(request.url).toBe(LEGACY_REQUESTS.tavily.url);
    expect(request.headers).toEqual(LEGACY_REQUESTS.tavily.headers);
    expect(JSON.parse(String(request.body))).toEqual(LEGACY_REQUESTS.tavily.body);
  });

  it("Brave", () => {
    const request = buildSearchRequest(BRAVE_TEMPLATE.spec, "https://api.search.brave.com", {
      query: "vendor api",
      limit: 6,
      apiKey: "secret",
    });
    expect(request.method).toBe(LEGACY_REQUESTS.brave.method);
    expect(request.url).toBe(LEGACY_REQUESTS.brave.url);
    expect(request.headers).toEqual(LEGACY_REQUESTS.brave.headers);
    expect(request.body).toBeUndefined();
  });

  it("SearXNG", () => {
    const request = buildSearchRequest(SEARXNG_TEMPLATE.spec, "http://relay-search.web:8080", {
      query: "vendor api",
      limit: 6,
    });
    expect(request.method).toBe(LEGACY_REQUESTS.searxng.method);
    expect(request.url).toBe(LEGACY_REQUESTS.searxng.url);
    expect(request.headers).toEqual(LEGACY_REQUESTS.searxng.headers);
  });

  it("the count is a number, not a string", () => {
    // Tavily documents `max_results` as an integer. A spec that sent "6"
    // would be rejected by the vendor, and the old adapter sent 6.
    const request = buildSearchRequest(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
      query: "q",
      limit: 6,
      apiKey: "secret",
    });
    expect(typeof JSON.parse(String(request.body)).max_results).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 2. A row written before the protocol still behaves the old way
// ---------------------------------------------------------------------------

describe("a row written before the protocol is read the old way", () => {
  it("a Tavily row's address was the whole endpoint, and still is", () => {
    const config = effectiveSearchConfig({
      kind: "tavily",
      baseUrl: "https://proxy.example.com/tavily",
      spec: null,
    });
    expect(config).not.toBeNull();
    expect(config!.legacy).toBe(true);
    expect(effectiveEndpoint(config!)).toBe("https://proxy.example.com/tavily");
  });

  it("a SearXNG row's address was a service root, and still is", () => {
    const config = effectiveSearchConfig({
      kind: "searxng",
      baseUrl: "http://relay-search.web:8080",
      spec: null,
    });
    expect(config).not.toBeNull();
    expect(effectiveEndpoint(config!)).toBe("http://relay-search.web:8080/search");
  });

  it("a row with no address uses the template's default", () => {
    const config = effectiveSearchConfig({ kind: "tavily", baseUrl: "", spec: null });
    expect(effectiveEndpoint(config!)).toBe("https://api.tavily.com/search");
  });

  it("a row with a spec uses the spec's path, and the address is a root", () => {
    const config = effectiveSearchConfig({
      kind: "tavily",
      baseUrl: "https://api.tavily.com",
      spec: {
        specVersion: 1,
        vendor: "tavily",
        transport: { method: "POST", path: "/v2/search", body: { query: "$.query" } },
        auth: { type: "bearer" },
        response: { items: "$.results", fields: { title: "$.title", url: "$.url", snippet: "$.content" } },
      },
    });
    expect(config).not.toBeNull();
    expect(config!.legacy).toBe(false);
    expect(effectiveEndpoint(config!)).toBe("https://api.tavily.com/v2/search");
  });

  it("a kind that names no template and carries no spec says so instead of guessing", () => {
    expect(effectiveSearchConfig({ kind: "serper", baseUrl: "https://s.example", spec: null })).toBeNull();
  });

  it("and the request it sends is the one the old adapter sent", () => {
    // The pinning above covers the *template*. The rows written before the
    // protocol are read differently — their address is the whole endpoint — and
    // their request was the one that was never pinned. The engine turned the
    // empty path into a "/" and sent `…/tavily/` instead of `…/tavily`: one
    // byte different, on every request, to every deployment that had such a
    // row. The promise in `effective.ts` is "one request does not change", so
    // the promise is pinned here.
    const config = effectiveSearchConfig({
      kind: "tavily",
      baseUrl: "https://proxy.example.com/tavily",
      spec: null,
    });
    const request = buildSearchRequest(config!.spec, config!.baseUrl, {
      query: "vendor api",
      limit: 6,
      apiKey: "secret",
    });
    expect(request.url).toBe("https://proxy.example.com/tavily");
    expect(request.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// 3. What the protocol accepts
// ---------------------------------------------------------------------------

const VALID_SPEC = {
  specVersion: 1,
  displayName: "Example",
  vendor: "example",
  baseUrl: "https://api.example.com",
  transport: {
    method: "POST",
    path: "/search",
    headers: { "content-type": "application/json" },
    body: { query: "$.query", max_results: "$.limit" },
  },
  auth: { type: "bearer" },
  response: {
    items: "$.results",
    fields: { title: "$.title", url: "$.url", snippet: "$.content" },
  },
  limits: { timeoutMs: 15000 },
};

describe("a valid spec is accepted", () => {
  it("as a whole", () => {
    const parsed = parseSearchSpec(VALID_SPEC);
    expect(parsed.ok).toBe(true);
  });

  it("and every built-in template passes its own validator", () => {
    for (const template of SEARCH_TEMPLATES) {
      const result = validateSearchSpec(template.spec);
      expect(result.errors, `${template.id}: ${result.errors.join("; ")}`).toEqual([]);
    }
  });
});

describe("the protocol refuses what it cannot read", () => {
  it("an unknown field at the top level", () => {
    const parsed = parseSearchSpec({ ...VALID_SPEC, respones: {} });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/spec\.respones.*unknown field/);
  });

  it("an unknown field inside transport", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      transport: { ...VALID_SPEC.transport, contntType: "application/json" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/transport\.contntType.*unknown field/);
  });

  it("an unknown field inside response.fields", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      response: { ...VALID_SPEC.response, fields: { ...VALID_SPEC.response.fields, titel: "$.t" } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/response\.fields\.titel.*unknown field/);
  });

  it("a path that is not a path", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      response: { ...VALID_SPEC.response, items: "results" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/response\.items.*is not a path/);
  });

  it("a placeholder the engine cannot fill", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      transport: { ...VALID_SPEC.transport, body: { query: "$.query", page: "{{$.page}}" } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/unknown placeholder/);
  });

  it("a request that never carries the search term", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      transport: { method: "GET", path: "/search", query: { q: "$.somethingElse" } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/no parameter carries \$\.query/);
  });

  it("a body on a GET request", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      transport: { method: "GET", path: "/search", query: { q: "$.query" }, body: { q: "$.query" } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/a GET request has no body/);
  });

  it("a path that does not start with a slash", () => {
    const parsed = parseSearchSpec({
      ...VALID_SPEC,
      transport: { method: "GET", path: "search", query: { q: "$.query" } },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/must start with/);
  });

  it("a missing version", () => {
    const { specVersion, ...rest } = VALID_SPEC;
    void specVersion;
    const parsed = parseSearchSpec(rest);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/specVersion/);
  });
});

// ---------------------------------------------------------------------------
// 4. Reading the answer
// ---------------------------------------------------------------------------

describe("reading the answer", () => {
  const spec = TAVILY_TEMPLATE.spec;

  it("takes the hits out of the vendor's shape", () => {
    const results = parseSearchResults(spec, {
      results: [
        { title: "Image API", url: "https://docs.example/images", content: "How to generate images." },
      ],
    });
    expect(results).toEqual([
      { title: "Image API", url: "https://docs.example/images", snippet: "How to generate images." },
    ]);
  });

  it("reads a result array that is one level deeper", () => {
    const results = parseSearchResults(BRAVE_TEMPLATE.spec, {
      web: { results: [{ title: "Docs", url: "https://docs.example/", description: "Reference" }] },
    });
    expect(results).toEqual([
      { title: "Docs", url: "https://docs.example/", snippet: "Reference" },
    ]);
  });

  it("takes the first field the vendor actually filled", () => {
    const results = parseSearchResults(SEARXNG_TEMPLATE.spec, {
      results: [{ title: "A", url: "https://a.example", snippet: "从 snippet 读的" }],
    });
    expect(results[0].snippet).toBe("从 snippet 读的");
  });

  it("drops anything that is not an http(s) destination", () => {
    const results = parseSearchResults(spec, {
      results: [
        { title: "js", url: "javascript:alert(1)" },
        { title: "file", url: "file:///etc/passwd" },
        { title: "creds", url: "https://user:pass@example.com/" },
        { title: "ok", url: "https://ok.example/" },
      ],
    });
    expect(results.map((r) => r.url)).toEqual(["https://ok.example/"]);
  });

  it("dedupes by URL and strips markup", () => {
    const results = parseSearchResults(spec, {
      results: [
        { title: "<b>Docs</b>", url: "https://a.example/", content: "one <i>two</i>" },
        { title: "Duplicate", url: "https://a.example/", content: "again" },
      ],
    });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Docs");
    expect(results[0].snippet).toBe("one two");
  });

  it("an answer that is not an array is no results, not a crash", () => {
    expect(parseSearchResults(spec, { results: "nope" })).toEqual([]);
    expect(parseSearchResults(spec, null)).toEqual([]);
  });

  it("caps the hits at the number that was asked for", () => {
    // A vendor that does not take a count — SearXNG, whose JSON output has no
    // such parameter — answers with everything it has, and the caller asked
    // for five. The old adapters sliced the list for exactly this reason.
    const many = Array.from({ length: 50 }, (_, i) => ({
      title: `T${i}`,
      url: `https://e.example/${i}`,
      content: "c",
    }));
    expect(parseSearchResults(SEARXNG_TEMPLATE.spec, { results: many }, 5)).toHaveLength(5);
    expect(parseSearchResults(SEARXNG_TEMPLATE.spec, { results: many })).toHaveLength(50);
  });

  it("and the engine caps them too, not just the parser", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      title: `T${i}`,
      url: `https://e.example/${i}`,
      content: "c",
    }));
    const results = await executeSearch(SEARXNG_TEMPLATE.spec, "http://s.example", {
      query: "q",
      limit: 3,
      displayName: "SearXNG",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ results: many }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 5. The credential
// ---------------------------------------------------------------------------

describe("the credential", () => {
  it("a bearer key goes into the authorization header", () => {
    const request = buildSearchRequest(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
      query: "q",
      limit: 3,
      apiKey: "k",
    });
    expect(request.headers.authorization).toBe("Bearer k");
  });

  it("a header key goes into the header the spec names", () => {
    const request = buildSearchRequest(BRAVE_TEMPLATE.spec, "https://api.search.brave.com", {
      query: "q",
      limit: 3,
      apiKey: "k",
    });
    expect(request.headers["x-subscription-token"]).toBe("k");
  });

  it("no key means no credential at all — never an empty one", () => {
    const request = buildSearchRequest(SEARXNG_TEMPLATE.spec, "http://s.example", {
      query: "q",
      limit: 3,
    });
    expect(request.headers["x-api-key"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Errors
// ---------------------------------------------------------------------------

describe("what the vendor says", () => {
  const failing = (status: number) =>
    (async () => new Response("nope", { status })) as unknown as typeof fetch;

  it("a refused credential names the provider and the hint", async () => {
    await expect(
      executeSearch(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
        query: "q",
        limit: 3,
        apiKey: "bad",
        displayName: "Tavily",
        credentialHint: "TAVILY_API_KEY",
        fetchImpl: failing(401),
      }),
    ).rejects.toThrow(/Tavily[\s\S]*HTTP 401[\s\S]*TAVILY_API_KEY/);
  });

  it("throttling is not a bad key", async () => {
    await expect(
      executeSearch(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
        query: "q",
        limit: 3,
        apiKey: "k",
        displayName: "Tavily",
        fetchImpl: failing(429),
      }),
    ).rejects.toThrow(/限流/);
  });

  it("an answer that is not JSON says so, rather than returning nothing", async () => {
    await expect(
      executeSearch(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
        query: "q",
        limit: 3,
        apiKey: "k",
        displayName: "Tavily",
        fetchImpl: (async () => new Response("<html>error</html>", { status: 200 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/不是 JSON/);
  });
});

// ---------------------------------------------------------------------------
// 7. Drift
// ---------------------------------------------------------------------------

describe("the stored copy against the template", () => {
  it("a template's own spec is in sync", () => {
    expect(specDrift(TAVILY_TEMPLATE.spec).kind).toBe("in-sync");
  });

  it("a spec with a changed parameter is reported, with the path", () => {
    const changed = {
      ...TAVILY_TEMPLATE.spec,
      transport: {
        ...TAVILY_TEMPLATE.spec.transport,
        body: { ...(TAVILY_TEMPLATE.spec.transport.body as Record<string, unknown>), search_depth: "advanced" },
      },
    };
    const drift = specDrift(changed);
    expect(drift.kind).toBe("differs");
    if (drift.kind === "differs") {
      expect(drift.templateId).toBe("tavily");
      expect(drift.paths.join(" ")).toMatch(/search_depth/);
    }
  });

  it("the operator's own address and name are not drift", () => {
    const renamed = { ...TAVILY_TEMPLATE.spec, displayName: "我的 Tavily", baseUrl: "https://my-proxy.example" };
    expect(specDrift(renamed).kind).toBe("in-sync");
  });

  it("a spec for a vendor with no template says so", () => {
    const custom = { ...TAVILY_TEMPLATE.spec, vendor: "serper" };
    expect(specDrift(custom).kind).toBe("no-template");
  });
});

describe("the templates are the ones the panel offers", () => {
  it("every built-in kind resolves to its template", () => {
    for (const id of ["tavily", "brave", "searxng"]) {
      expect(searchTemplateByKind(id)?.id).toBe(id);
    }
  });
});
