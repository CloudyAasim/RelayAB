/**
 * tests/unit/assistant-web-search.test.ts
 *
 * `web_search` — the half of research the assistant was missing.
 *
 * `fetch_page` can read a URL the model already knows. A model that does not
 * know the vendor's documentation address could only recall one (which is how
 * an invented endpoint reaches a spec) or ask the user. There is no keyless
 * backend on purpose: the obvious scrapers were measured and each degraded
 * into either captchas or results for the wrong query, and a silent "no
 * results" is worse than a clear "not configured".
 *
 * Everything here runs against an injected fetch and an injected environment,
 * so no test needs a key or touches the network.
 */
import { describe, it, expect, vi } from "vitest";

import {
  resolveSearchBackend,
  searchWeb,
  WebSearchError,
  MAX_SEARCH_RESULTS,
} from "@/lib/assistant/web-search";
import { toolDefinitions, executeTool } from "@/lib/assistant/tools";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("which backend is used", () => {
  it("prefers Tavily, then Brave, then SearXNG", () => {
    expect(
      resolveSearchBackend(
        env({ TAVILY_API_KEY: "t", BRAVE_SEARCH_API_KEY: "b", SEARXNG_URL: "https://s.example" }),
      )?.provider,
    ).toBe("tavily");
    expect(
      resolveSearchBackend(env({ BRAVE_SEARCH_API_KEY: "b", SEARXNG_URL: "https://s.example" }))?.provider,
    ).toBe("brave");
    expect(resolveSearchBackend(env({ SEARXNG_URL: "https://s.example" }))?.provider).toBe("searxng");
  });

  it("is null when nothing is configured", () => {
    expect(resolveSearchBackend(env({}))).toBeNull();
  });

  it("refuses a SearXNG URL that is not http(s)", () => {
    expect(resolveSearchBackend(env({ SEARXNG_URL: "file:///etc/passwd" }))).toBeNull();
  });
});

describe("Tavily", () => {
  it("normalizes results and sends the key as a bearer token", async () => {
    const impl = vi.fn(async () =>
      json({
        results: [
          { title: "Image API", url: "https://docs.example/images", content: "How to generate images." },
          { title: "Audio API", url: "https://docs.example/audio", content: "How to synthesize speech." },
        ],
      }),
    ) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

    const outcome = await searchWeb("vendor image api", {
      fetchImpl: impl,
      env: env({ TAVILY_API_KEY: "secret-key" }),
      limit: 5,
    });

    expect(outcome.provider).toBe("tavily");
    expect(outcome.results.map((r) => r.url)).toEqual([
      "https://docs.example/images",
      "https://docs.example/audio",
    ]);
    const init = impl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "vendor image api", max_results: 5 });
  });
});

describe("Brave", () => {
  it("reads web.results and sends the subscription token", async () => {
    const impl = vi.fn(async () =>
      json({ web: { results: [{ title: "Docs", url: "https://docs.example/", description: "Reference" }] } }),
    ) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

    const outcome = await searchWeb("docs", {
      fetchImpl: impl,
      env: env({ BRAVE_SEARCH_API_KEY: "brave-key" }),
    });

    expect(outcome.results).toEqual([
      { title: "Docs", url: "https://docs.example/", snippet: "Reference" },
    ]);
    const [calledUrl, init] = impl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("q=docs");
    expect(calledUrl).toContain("search_lang=zh-hans");
    expect((init.headers as Record<string, string>)["x-subscription-token"]).toBe("brave-key");
  });
});

describe("SearXNG", () => {
  it("calls the JSON endpoint under the configured base path", async () => {
    const impl = vi.fn(async () => json({ results: [{ title: "A", url: "https://a.example", content: "aa" }] })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

    const outcome = await searchWeb("query", {
      fetchImpl: impl,
      env: env({ SEARXNG_URL: "https://search.example/searxng" }),
    });

    expect(outcome.provider).toBe("searxng");
    const [calledUrl] = impl.mock.calls[0];
    expect(calledUrl.startsWith("https://search.example/searxng/search?")).toBe(true);
    expect(calledUrl).toContain("format=json");
  });

  it("sends the optional API key when one is set", async () => {
    const impl = vi.fn(async () => json({ results: [] })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await searchWeb("q", {
      fetchImpl: impl,
      env: env({ SEARXNG_URL: "https://s.example/", SEARXNG_API_KEY: "k" }),
    });
    const init = impl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });
});

describe("what a result is allowed to contain", () => {
  const tavilyReturning = (results: unknown[]) =>
    vi.fn(async () => json({ results })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };

  it("drops anything that is not an http(s) destination", async () => {
    const impl = tavilyReturning([
      { title: "js", url: "javascript:alert(1)" },
      { title: "file", url: "file:///etc/passwd" },
      { title: "ok", url: "https://ok.example/" },
    ]);
    const outcome = await searchWeb("q", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }) });
    expect(outcome.results.map((r) => r.url)).toEqual(["https://ok.example/"]);
  });

  it("dedupes by URL and strips markup from titles and snippets", async () => {
    const impl = tavilyReturning([
      { title: "<b>Docs</b>", url: "https://a.example/", content: "one <i>two</i>" },
      { title: "Duplicate", url: "https://a.example/", content: "again" },
    ]);
    const outcome = await searchWeb("q", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }) });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].title).toBe("Docs");
    expect(outcome.results[0].snippet).toBe("one two");
  });

  it("caps the limit at the documented maximum", async () => {
    const impl = vi.fn(async () => json({ results: [] })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await searchWeb("q", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }), limit: 50 });
    const init = impl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).max_results).toBe(MAX_SEARCH_RESULTS);
  });

  it("refuses an empty query without calling the provider", async () => {
    const impl = vi.fn(async () => json({ results: [] })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await expect(
      searchWeb("   ", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }) }),
    ).rejects.toBeInstanceOf(WebSearchError);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("when the backend cannot answer", () => {
  it("says exactly which variable to set", async () => {
    await expect(searchWeb("q", { env: env({}) })).rejects.toThrow(
      /TAVILY_API_KEY[\s\S]*BRAVE_SEARCH_API_KEY[\s\S]*SEARXNG_URL/,
    );
  });

  it("names the key that was rejected", async () => {
    const impl = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await expect(
      searchWeb("q", { fetchImpl: impl, env: env({ BRAVE_SEARCH_API_KEY: "bad" }) }),
    ).rejects.toThrow(/HTTP 401[\s\S]*BRAVE_SEARCH_API_KEY/);
  });

  it("distinguishes throttling from a bad key", async () => {
    const impl = vi.fn(async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await expect(
      searchWeb("q", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }) }),
    ).rejects.toThrow(/限流/);
  });

  it("reports an unreachable provider rather than hanging", async () => {
    const impl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } };
    await expect(
      searchWeb("q", { fetchImpl: impl, env: env({ TAVILY_API_KEY: "k" }) }),
    ).rejects.toThrow(/连不上/);
  });
});

describe("the tool, through the same path a turn uses", () => {
  it("is offered to both tiers", () => {
    for (const tier of [true, false]) {
      expect(toolDefinitions(tier).map((t) => t.function.name), `tier ${tier}`).toContain("web_search");
    }
  });

  it("turns a missing backend into a result the model can report", async () => {
    // The tool reads the real environment, so the assertion has to own the
    // fact that no backend is configured there.
    const keys = ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "SEARXNG_URL"] as const;
    const saved = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      const result = await executeTool("web_search", JSON.stringify({ query: "anything" }), {
        user: { id: "u1", username: "u", role: "user", timezone: "shanghai" },
      } as never);
      expect(result.ok).toBe(false);
      // The wording moved when providers became a list: the message now has to
      // name the panel *and* the environment fallback, because either can fix it.
      expect(result.content).toMatch(/没有可用的搜索后端[\s\S]*网页搜索[\s\S]*SEARXNG_URL/);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("refuses with no query at all", async () => {
    const result = await executeTool("web_search", "{}", {
      user: { id: "u1", username: "u", role: "user", timezone: "shanghai" },
    } as never);
    expect(result.ok).toBe(false);
  });
});
