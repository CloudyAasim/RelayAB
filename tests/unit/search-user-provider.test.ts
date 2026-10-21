/**
 * tests/unit/search-user-provider.test.ts
 *
 * Two things this file holds up:
 *
 *  1. **The engine's regressions.** The search protocol was rebuilt around a
 *     generic engine, and a few of its promises were not kept by the code: a
 *     row written before the protocol got a trailing slash on every request
 *     (a promise of "one request does not change" broken by one byte), a
 *     documented field (`limits.maxResults`) validated and then ignored, and
 *     a template that dropped the type of the value it filled in.
 *
 *  2. **The user's own search service.** The assistant could only search
 *     through the deployment's providers, which the deployment pays for. A
 *     user with a search service of their own now has somewhere to put it, and
 *     the money follows the right bill: their key pays their vendor, and the
 *     account is not charged for a call the deployment did not pay for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey, listApiKeyIdsForUsage } from "@/lib/db/keys";
import { listUsageByKey } from "@/lib/db/usage";
import { getAssistantSettings, saveAssistantSettings } from "@/lib/db/assistant";
import { createSearchProvider } from "@/lib/db/search-providers";
import { createAssistantCredential, setAssistantCredentialEnabled } from "@/lib/db/assistant-keys";
import { executeTool } from "@/lib/assistant/tools";
import {
  buildSearchRequest,
  effectiveLimit,
  executeSearch,
  parseSearchResults,
} from "@/lib/search/engine";
import { effectiveSearchConfig } from "@/lib/search/effective";
import { TAVILY_TEMPLATE, OPENAI_COMPATIBLE_TEMPLATE } from "@/lib/search/templates";
import { parseSearchSpec, type SearchSpec } from "@/lib/search/spec";
import { userSearchBackend } from "@/lib/search/user";
import { DICTS } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const PROTOCOL_DOC = readFileSync(
  join(ROOT, "docs", "搜索适配协议", "README.md"),
  "utf-8",
);
const USER_DOCS = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "docs", "DocsContent.tsx"),
  "utf-8",
);

const SEARCH_ENV = ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "SEARXNG_URL"] as const;
let savedEnv: Array<readonly [string, string | undefined]> = [];

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
  savedEnv = SEARCH_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of SEARCH_ENV) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("a row written before the protocol", () => {
  it("is asked for exactly the address it was stored with", () => {
    // The old code sent `fetch(endpoint)` — the stored address, as it stood.
    // The engine turned the empty path into a "/" and asked for
    // `…/search/` instead, which is a different URL on every request, to every
    // deployment that had a row written before the protocol existed.
    const config = effectiveSearchConfig({
      kind: "tavily",
      baseUrl: "https://proxy.example.com/tavily",
      spec: null,
    });
    expect(config).not.toBeNull();
    const request = buildSearchRequest(config!.spec, config!.baseUrl, {
      query: "q",
      limit: 3,
      apiKey: "secret",
    });
    expect(request.url).toBe("https://proxy.example.com/tavily");
    // And the panel's preview agrees with it.
    expect(config!.spec.transport.path).toBe("");
  });

  it("and a Brave row keeps its own path too", () => {
    const config = effectiveSearchConfig({
      kind: "brave",
      baseUrl: "https://proxy.example.com/brave",
      spec: null,
    });
    const request = buildSearchRequest(config!.spec, config!.baseUrl, { query: "q", limit: 3 });
    // A GET, so the query string is on the URL — the *path* is what the row
    // was stored with, and it is not one byte longer than it was.
    expect(new URL(request.url).pathname).toBe("/brave");
  });
});

describe("the limits a spec declares", () => {
  it("cap the request, not only the answer", () => {
    // `limits.maxResults` is what a vendor accepts. Asking for six when it
    // takes three is a request the vendor refuses, and the field used to be
    // validated and then ignored — the exact failure this protocol exists to
    // end.
    const spec: SearchSpec = {
      ...TAVILY_TEMPLATE.spec,
      limits: { timeoutMs: 15000, maxResults: 2 },
    };
    expect(effectiveLimit(spec, 6)).toBe(2);
    const request = buildSearchRequest(spec, "https://api.tavily.com", { query: "q", limit: 6 });
    expect(JSON.parse(String(request.body)).max_results).toBe(2);
    // And the answer is cut to the same number.
    const payload = {
      results: [1, 2, 3, 4, 5, 6].map((n) => ({ title: "t", url: `https://e.com/${n}` })),
    };
    expect(parseSearchResults(spec, payload, effectiveLimit(spec, 6))).toHaveLength(2);
  });
});

describe("the values a spec sends", () => {
  it("keep their type when the value is exactly one placeholder", () => {
    // Tavily documents `max_results` as an integer and rejects the string
    // form. A template that resolved to a string was a 400 waiting to happen.
    const request = buildSearchRequest(TAVILY_TEMPLATE.spec, "https://api.tavily.com", {
      query: "q",
      limit: 6,
      apiKey: "secret",
    });
    expect(typeof JSON.parse(String(request.body)).max_results).toBe("number");
  });

  it("and a nested one is filled rather than shipped as text", () => {
    // A vendor that wants the query inside an envelope is a vendor whose spec
    // says so. The check that the query reaches the vendor used to look only
    // at the top level, so a nested placeholder passed validation and then
    // reached the vendor as the literal text `{{$.query}}`.
    const spec: SearchSpec = {
      specVersion: 1,
      transport: {
        method: "POST",
        path: "/search",
        body: { opts: { q: "{{$.query}}" } },
      },
      response: { items: "$.results", fields: { title: "$.t", url: "$.u", snippet: "$.s" } },
    };
    const parsed = parseSearchSpec(spec);
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
    const request = buildSearchRequest(parsed.ok ? parsed.spec : spec, "https://api.example.com", {
      query: "vendor api",
      limit: 3,
    });
    expect(JSON.parse(String(request.body))).toEqual({ opts: { q: "vendor api" } });
  });
});

describe("an address that cannot be used", () => {
  it("is refused rather than silently changed", () => {
    // `https://host?x=1` + `/search` is `https://host?x=1/search`: the path
    // lands in the query string and the endpoint is gone.
    expect(() =>
      buildSearchRequest(TAVILY_TEMPLATE.spec, "https://host?x=1", { query: "q", limit: 1 }),
    ).toThrow(/不合法/);
  });
});

describe("the user's own search service", () => {
  async function makeUser(name: string, quota = 100 * 1000) {
    const user = await createUser({
      username: name,
      password: "correct horse battery",
      displayName: name,
      quotaLimit: quota,
    });
    expect(user).not.toBeNull();
    return user!;
  }

  function ctxFor(userId: string, over: Record<string, unknown> = {}) {
    return {
      user: { id: userId, username: "u", role: "user", timezone: "shanghai" },
      ...over,
    } as never;
  }

  /**
   * The account identity: the assistant credential, created and switched on.
   *
   * The deployment's search service needs it — it is the deployment's money
   * spent on the account's behalf — and it needs no key of the user's: the
   * system issues it. A test that exercises the deployment's provider has to
   * grant it, or it is testing the refusal.
   */
  async function grantAccountIdentity(userId: string): Promise<void> {
    await createAssistantCredential(userId);
    await setAssistantCredentialEnabled(userId, true);
  }

  function okResponse() {
    return new Response(
      JSON.stringify({
        object: "search",
        results: [{ title: "A", url: "https://a.example/", snippet: "a" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  it("is remembered, with its key, on the account's own row", async () => {
    const user = await makeUser("own");
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchBaseUrl: "https://93.184.216.34/v1/search",
      searchApiKey: "sk-mine",
    });
    const stored = await getAssistantSettings(user.id);
    expect(stored?.searchBaseUrl).toBe("https://93.184.216.34/v1/search");
    // The key is encrypted, never in the clear.
    expect(stored?.encryptedSearchApiKey).toBeTruthy();
    expect(stored?.encryptedSearchApiKey).not.toContain("sk-mine");
  });

  it("becomes a backend that speaks the OpenAI-compatible shape", async () => {
    const user = await makeUser("own2");
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchBaseUrl: "https://93.184.216.34/v1/search",
      searchApiKey: "sk-mine",
    });
    const backend = await userSearchBackend(user.id);
    expect(backend).not.toBeNull();
    expect(backend!.source).toBe("user");
    // The address is the whole endpoint: nothing is appended to it.
    const request = buildSearchRequest(backend!.spec, backend!.endpointBase, {
      query: "q",
      limit: 3,
      apiKey: backend!.apiKey,
    });
    expect(request.url).toBe("https://93.184.216.34/v1/search");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer sk-mine");
    expect(JSON.parse(String(request.body))).toEqual({ query: "q", limit: 3 });
  });

  it("and is absent when the account has not configured one", async () => {
    const user = await makeUser("own3");
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
    });
    expect(await userSearchBackend(user.id)).toBeNull();
  });

  it("is not charged to the account — the user's own key paid their vendor", async () => {
    const user = await makeUser("own4");
    const { key } = await createApiKey({ userId: user.id, label: "k" });
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchBaseUrl: "https://93.184.216.34/v1/search",
      searchApiKey: "sk-mine",
    });
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "web_search",
      JSON.stringify({ query: "hello" }),
      ctxFor(user.id),
    );
    expect(result.ok, result.content).toBe(true);
    // The balance did not move, and no usage row was written: the deployment
    // served no paid upstream, so there is nothing to bill for.
    expect((await getUserById(user.id))?.quotaUsed).toBe(0);
    expect(await listUsageByKey(key.id)).toHaveLength(0);
    // And the call went to the user's own address.
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://93.184.216.34/v1/search");
  });

  it("while the deployment's own provider is charged", async () => {
    // The other half of the rule: the operator pays that vendor, so the
    // account pays the operator. The assistant's tool used to charge nobody
    // at all, which made every assistant search a free ride on the
    // operator's account and invisible in every report.
    const user = await makeUser("dep");
    await grantAccountIdentity(user.id);
    const { key } = await createApiKey({ userId: user.id, label: "k" });
    await createSearchProvider({
      name: "dep",
      kind: "tavily",
      baseUrl: "https://api.tavily.com",
      apiKey: "sk-vendor",
      enabled: true,
      priority: 1,
      creditsPerCall: 1,
    });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ results: [{ title: "A", url: "https://a.example/", content: "a" }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "web_search",
      JSON.stringify({ query: "hello" }),
      ctxFor(user.id),
    );
    expect(result.ok, result.content).toBe(true);
    expect((await getUserById(user.id))?.quotaUsed).toBe(1000);
    // The row hangs off one of the account's keys — which one is the
    // repository's business, so the assertion is over all of them.
    const rows = [];
    for (const id of await listApiKeyIdsForUsage(user.id)) {
      rows.push(...(await listUsageByKey(id)));
    }
    expect(rows).toHaveLength(1);
  });

  it("and an account that cannot pay is refused before the vendor is called", async () => {
    const user = await makeUser("broke", 0);
    await grantAccountIdentity(user.id);
    await createApiKey({ userId: user.id, label: "k" });
    await createSearchProvider({
      name: "dep",
      kind: "tavily",
      baseUrl: "https://api.tavily.com",
      apiKey: "sk-vendor",
      enabled: true,
      priority: 1,
      creditsPerCall: 1,
    });
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "web_search",
      JSON.stringify({ query: "hello" }),
      ctxFor(user.id),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/积分余额不足/);
    expect(fetchMock, "the vendor was called for a call nobody could pay for").not.toHaveBeenCalled();
  });

  it("and a token-pool account is told why, rather than charged at an invented rate", async () => {
    const user = await createUser({
      username: "tokens",
      password: "correct horse battery",
      displayName: "tokens",
      quotaType: "tokens",
      quotaLimit: 1_000_000,
    });
    await grantAccountIdentity(user!.id);
    await createApiKey({ userId: user!.id, label: "k" });
    await createSearchProvider({
      name: "dep",
      kind: "tavily",
      baseUrl: "https://api.tavily.com",
      apiKey: "sk-vendor",
      enabled: true,
      priority: 1,
      creditsPerCall: 1,
    });
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "web_search",
      JSON.stringify({ query: "hello" }),
      ctxFor(user!.id),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what the documents say about it", () => {
  it("the protocol document says the test button is billed", () => {
    // It said "不计费、不写用量" for months after the test became a real,
    // billed search — and the protocol document is rendered in the admin
    // panel, so an operator read a false statement.
    expect(PROTOCOL_DOC).toMatch(/后台「测试」按钮[\s\S]{0,200}计费/);
    expect(PROTOCOL_DOC).not.toMatch(/后台「测试」按钮[\s\S]{0,80}不计费/);
  });

  it("the protocol document says an empty path means the whole endpoint", () => {
    expect(PROTOCOL_DOC).toMatch(/transport\.path` 写空字符串/);
  });

  it("and the user document mentions the search service of their own", () => {
    const userDict = Object.entries(DICTS["zh-CN"])
      .filter(([key]) => key.startsWith("docs."))
      .map(([, value]) => value)
      .join("\n");
    expect(USER_DOCS + userDict).toMatch(/自己的搜索服务/);
  });

  it("and the OpenAI-compatible template is one of the built-in ones", () => {
    expect(OPENAI_COMPATIBLE_TEMPLATE.id).toBe("openai-compatible");
    // The address is the endpoint: the path is empty.
    expect(OPENAI_COMPATIBLE_TEMPLATE.spec.transport.path).toBe("");
    // And it parses under the protocol's own validator.
    const parsed = parseSearchSpec(OPENAI_COMPATIBLE_TEMPLATE.spec);
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
  });
});

describe("the engine's own guarantees", () => {
  it("a timeout while the body is arriving is a timeout, not a broken answer", async () => {
    // Truncating the body and reporting "the vendor did not answer with JSON"
    // blames the vendor for our deadline.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":['));
        // Never closed: the read hangs until the deadline.
      },
    });
    const res = new Response(body, { status: 200 });
    const spec: SearchSpec = {
      ...TAVILY_TEMPLATE.spec,
      limits: { timeoutMs: 30 },
    };
    // The body never ends, so the deadline is what ends the read.
    const fetchImpl = vi.fn(async () => res);
    await expect(
      executeSearch(spec, "https://api.example.com", {
        query: "q",
        limit: 1,
        displayName: "X",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/超时|timeout/i);
  });
});
