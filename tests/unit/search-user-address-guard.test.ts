/**
 * tests/unit/search-user-address-guard.test.ts
 *
 * A user's own search service is an address a stranger typed, and the request
 * is made by **the gateway**.
 *
 * That is the whole problem in one sentence. The operator's own provider rows
 * may point at a private network on purpose — a self-hosted SearXNG behind a
 * Docker network name is a normal thing to run, and the operator runs the box.
 * A user's address has no such standing: `http://127.0.0.1:3000/v1/search`
 * is the gateway's own port, `http://169.254.169.254/` is the cloud metadata
 * endpoint, and the answer to either comes back as search results.
 *
 * `fetch_page` has answered this question for a long time (see
 * `src/lib/assistant/web-fetch.ts`). The search path did not, and the two
 * doors into the same deployment had different rules.
 *
 * These tests pin the rule on the search side:
 *
 *   1. A user's own address must resolve to public addresses, and the request
 *      is not made at all when it does not.
 *   2. A redirect is not followed off the public internet — the address that
 *      was written down is not the address the request ends up at.
 *   3. The operator's own rows are **not** held to it, because a self-hosted
 *      instance on a private network is a legitimate thing to run.
 */
import { describe, it, expect, vi } from "vitest";

import { executeSearch, executeSearchWithReport } from "@/lib/search/engine";
import { OPENAI_COMPATIBLE_TEMPLATE, TAVILY_TEMPLATE } from "@/lib/search/templates";
import { isPrivateSearchAddress } from "@/lib/search/user";
import { createSearchBackend } from "@/lib/assistant/web-search";
import type { SearchSpec } from "@/lib/search/spec";

/** A spec that posts to the base address, the shape a user's own service has. */
function spec(): SearchSpec {
  return {
    ...OPENAI_COMPATIBLE_TEMPLATE.spec,
    limits: { timeoutMs: 500 },
  };
}

/** A fetch that records the call and answers with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

describe("a user's own search service may not point inside the deployment", () => {
  it("the request is not made at all when the address is a private one", async () => {
    const { impl, calls } = stubFetch({ results: [] });

    await expect(
      executeSearch(spec(), "http://127.0.0.1:3000/v1/search", {
        query: "q",
        limit: 1,
        displayName: "自己的搜索服务",
        publicOnly: true,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/内网|不能访问/);

    // The point of checking before the request: a metadata endpoint answers
    // with a credential, and no looking at the answer afterwards takes it back.
    expect(calls.length, "the request went out anyway").toBe(0);
  });

  it("the cloud metadata address is refused the same way", async () => {
    const { impl, calls } = stubFetch({ results: [] });

    await expect(
      executeSearch(spec(), "http://169.254.169.254/latest/meta-data/", {
        query: "q",
        limit: 1,
        displayName: "自己的搜索服务",
        publicOnly: true,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/内网|不能访问/);
    expect(calls.length).toBe(0);
  });

  it("a redirect is refused rather than followed", async () => {
    // A public address that answers 302 to an internal one is the same hole
    // with one more step in it, so the redirect is handed back, not followed.
    const { impl, calls } = stubFetch("", 302);

    await expect(
      executeSearch(spec(), "http://93.184.216.34/v1/search", {
        query: "q",
        limit: 1,
        displayName: "自己的搜索服务",
        publicOnly: true,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/重定向/);

    expect(calls.length, "the request never happened").toBe(1);
    // And the redirect was not handed to the platform to follow.
    expect(calls[0].init.redirect, "the redirect was followed").toBe("manual");
  });

  it("the operator's own provider is not held to it", async () => {
    // A self-hosted SearXNG on a private network is a normal deployment, and
    // the operator wrote the address themselves. Refusing it would break
    // exactly the setup this gateway exists to support.
    const { impl, calls } = stubFetch({ results: [] });

    const result = await executeSearch(spec(), "http://relay-search.internal:8080/search", {
      query: "q",
      limit: 1,
      displayName: "自建 SearXNG",
      fetchImpl: impl,
    });

    expect(result).toEqual([]);
    expect(calls.length, "the operator's own request never went out").toBe(1);
  });

  it("and the backend remembers which rule it is under", async () => {
    const own = createSearchBackend({
      spec: OPENAI_COMPATIBLE_TEMPLATE.spec,
      baseUrl: "https://search.example.com/v1/search",
      source: "user",
      publicOnly: true,
    });
    expect(own?.publicOnly, "a user's own service is not marked public-only").toBe(true);

    const operator = createSearchBackend({
      spec: TAVILY_TEMPLATE.spec,
      baseUrl: "https://api.tavily.com",
      apiKey: "k",
      source: "db",
    });
    expect(operator?.publicOnly, "the operator's own row was marked public-only").toBeUndefined();
  });
});

describe("the address is checked when it is typed, and when it is called", () => {
  it("a literal private address is recognised without a DNS round trip", () => {
    expect(isPrivateSearchAddress("http://127.0.0.1:3000/v1/search")).toBe(true);
    expect(isPrivateSearchAddress("http://localhost:8080/search")).toBe(true);
    expect(isPrivateSearchAddress("http://10.0.0.5/search")).toBe(true);
    expect(isPrivateSearchAddress("http://192.168.1.1/search")).toBe(true);
    expect(isPrivateSearchAddress("http://169.254.169.254/")).toBe(true);
    expect(isPrivateSearchAddress("http://[::1]:3000/search")).toBe(true);
    expect(isPrivateSearchAddress("http://redis.internal/search")).toBe(true);
  });

  it("a public address is left alone", () => {
    expect(isPrivateSearchAddress("https://api.tavily.com/search")).toBe(false);
    expect(isPrivateSearchAddress("https://search.example.com/v1/search")).toBe(false);
    expect(isPrivateSearchAddress("not a url")).toBe(false);
  });

  it("the probe is held to the same rule as the call", async () => {
    // The "test" button is a request the gateway makes on somebody else's
    // instructions, so a test that worked while the search was refused would
    // be a way to read an internal answer without it ever being a result.
    const { impl, calls } = stubFetch({ results: [] });

    await expect(
      executeSearchWithReport(spec(), "http://127.0.0.1:3000/v1/search", {
        query: "q",
        limit: 1,
        displayName: "自己的搜索服务",
        publicOnly: true,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(/内网|不能访问/);
    expect(calls.length).toBe(0);
  });
});
