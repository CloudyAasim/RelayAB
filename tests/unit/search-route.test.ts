/**
 * tests/unit/search-route.test.ts
 *
 * `POST /v1/search` — web search as a paid gateway endpoint.
 *
 * Two things are easy to get wrong here and both are about money:
 *
 *  - charging for a request that produced nothing. A search that never
 *    reached SearXNG, or that SearXNG refused, has nothing to bill for; an
 *    outage that bills reads as usage on the account.
 *  - charging after the fact without recording it, so the account pool moves
 *    and the usage table does not. The two are checked separately below.
 *
 * The route is called directly with a real Request and a real key, the same
 * way `/v1/models` and the media routes are tested.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { POST, GET } from "@/app/api/v1/search/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { listUsageByKey } from "@/lib/db/usage";
import { updateSettings } from "@/lib/db/settings";
import { createSearchProvider } from "@/lib/db/search-providers";

let userId = "";
let plainKey = "";
let keyId = "";

const saved = {
  searxng: process.env.SEARXNG_URL,
  price: process.env.SEARCH_CREDITS_PER_CALL,
};

beforeEach(async () => {
  __resetDbForTest();
  process.env.SEARXNG_URL = "https://search.example";
  process.env.SEARCH_CREDITS_PER_CALL = "1";
  const user = await createUser({
    username: "searcher",
    password: "pw-123456",
    role: "user",
    quotaType: "credits",
    // Stored in 0.001-积分 units: 100_000 = 100 积分, the same convention the
    // chat quota headers already report.
    quotaLimit: 100_000,
  });
  userId = user.id;
  const key = await createApiKey({ userId, label: "test" });
  plainKey = key.plainKey;
  keyId = key.key.id;
});

afterEach(() => {
  for (const [name, value] of [
    ["SEARXNG_URL", saved.searxng],
    ["SEARCH_CREDITS_PER_CALL", saved.price],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

function stubSearch(results: Array<{ title: string; url: string; content: string }>) {
  const impl = vi.fn(async () =>
    new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", impl);
  return impl;
}

function post(body: unknown, key = plainKey): Promise<Response> {
  return POST(
    new Request("https://api.example/v1/search", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("authentication", () => {
  it("refuses a request with no key", async () => {
    const res = await POST(new Request("https://api.example/v1/search", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("refuses an unknown key", async () => {
    const res = await post({ query: "x" }, "sk-relay-not-a-real-key");
    expect(res.status).toBe(401);
  });

  it("refuses an exhausted account before searching", async () => {
    const impl = stubSearch([]);
    // The route's auth path reads the row, so this is applied directly.
    const { getUserById: get, incrementUserQuotaUsed } = await import("@/lib/db/users");
    const user = await get(userId);
    await incrementUserQuotaUsed(userId, user!.quotaLimit);
    const res = await post({ query: "x" });
    expect(res.status).toBe(429);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe("a successful search", () => {
  it("returns the normalized results", async () => {
    stubSearch([
      { title: "Image API", url: "https://docs.example/images", content: "How to generate images." },
      { title: "Audio API", url: "https://docs.example/audio", content: "How to synthesize speech." },
    ]);

    const res = await post({ query: "vendor api", limit: 5 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      query: string;
      provider: string;
      results: Array<{ title: string; url: string; snippet: string }>;
      credits: number;
    };
    expect(body.object).toBe("search");
    expect(body.query).toBe("vendor api");
    expect(body.provider).toBe("searxng");
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual({
      title: "Image API",
      url: "https://docs.example/images",
      snippet: "How to generate images.",
    });
    expect(body.credits).toBe(1);
  });

  it("charges the account and records the usage row", async () => {
    stubSearch([{ title: "A", url: "https://a.example", content: "aa" }]);
    await post({ query: "x" });

    const user = await getUserById(userId);
    expect(user?.quotaUsed).toBe(1000); // 1 积分 = 1000 storage units
    const usage = await listUsageByKey(keyId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: "web-search",
      providerId: "searxng",
      creditsUsed: 1000,
      status: "success",
      capability: "web.search",
    });
  });

  it("attributes the call to the database provider that served it", async () => {
    // The environment still points at a SearXNG instance here: once a provider
    // row exists it is authoritative, and the usage row must name that row so
    // an operator can tell which backend earned the credits.
    const row = await createSearchProvider({
      name: "Local",
      kind: "searxng",
      baseUrl: "https://db.example",
      priority: 1,
    });
    stubSearch([{ title: "A", url: "https://a.example", content: "aa" }]);

    const res = await post({ query: "x" });
    expect(res.status).toBe(200);

    const usage = await listUsageByKey(keyId);
    expect(usage[0]).toMatchObject({
      model: "web-search",
      providerId: row.id,
      capability: "web.search",
    });
  });

  it("charges the active provider's own price, not the fallback", async () => {
    await updateSettings({ searchCreditsPerCall: 1 });
    const row = await createSearchProvider({
      name: "Paid",
      kind: "searxng",
      baseUrl: "https://paid.example",
      creditsPerCall: 3,
    });
    stubSearch([{ title: "A", url: "https://a.example", content: "aa" }]);

    const res = await post({ query: "x" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { credits: number }).credits).toBe(3);
    expect((await getUserById(userId))?.quotaUsed).toBe(3000);

    const usage = await listUsageByKey(keyId);
    expect(usage[0]).toMatchObject({ providerId: row.id, creditsUsed: 3000 });
  });

  it("reports the remaining balance in the quota headers", async () => {
    stubSearch([]);
    const res = await post({ query: "x" });
    expect(res.headers.get("x-ratelimit-limit")).toBe("100000");
    // 100 积分 granted minus the 1 积分 this call cost, in storage units.
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99000");
  });

  it("charges per call, not per result", async () => {
    stubSearch([
      { title: "A", url: "https://a.example", content: "aa" },
      { title: "B", url: "https://b.example", content: "bb" },
      { title: "C", url: "https://c.example", content: "cc" },
    ]);
    await post({ query: "x" });
    const user = await getUserById(userId);
    expect(user?.quotaUsed).toBe(1000);
  });

  it("honours SEARCH_CREDITS_PER_CALL", async () => {
    process.env.SEARCH_CREDITS_PER_CALL = "3";
    stubSearch([]);
    const res = await post({ query: "x" });
    expect(((await res.json()) as { credits: number }).credits).toBe(3);
    const user = await getUserById(userId);
    expect(user?.quotaUsed).toBe(3000);
  });

  it("prefers the price saved in the admin panel over the environment", async () => {
    // The panel is the authority; the environment is a fallback for
    // deployments that never open it. Getting this backwards makes a saved
    // edit look broken after the next restart.
    await updateSettings({ searchCreditsPerCall: 2 });
    process.env.SEARCH_CREDITS_PER_CALL = "5";
    stubSearch([]);
    const res = await post({ query: "x" });
    expect(((await res.json()) as { credits: number }).credits).toBe(2);
    expect((await getUserById(userId))?.quotaUsed).toBe(2000);
  });

  it("works over GET as well", async () => {
    stubSearch([{ title: "A", url: "https://a.example", content: "aa" }]);
    const res = await GET(
      new Request("https://api.example/v1/search?q=hello&limit=2", {
        headers: { authorization: `Bearer ${plainKey}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
  });
});

describe("what is refused without charging", () => {
  it("an empty query", async () => {
    const impl = stubSearch([]);
    const res = await post({ query: "   " });
    expect(res.status).toBe(400);
    expect(impl).not.toHaveBeenCalled();
    expect((await getUserById(userId))?.quotaUsed).toBe(0);
  });

  it("a query longer than the provider accepts", async () => {
    const res = await post({ query: "x".repeat(401) });
    expect(res.status).toBe(400);
    expect((await getUserById(userId))?.quotaUsed).toBe(0);
  });

  it("a deployment where an administrator turned search off", async () => {
    // The switch in the panel has to reach both doors. A disabled search that
    // still answers here is a button that lies.
    await updateSettings({ searchEnabled: false });
    const impl = stubSearch([]);
    const res = await post({ query: "x" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("search_disabled");
    expect(impl).not.toHaveBeenCalled();
    expect((await getUserById(userId))?.quotaUsed).toBe(0);
  });

  it("a deployment with no search backend", async () => {
    delete process.env.SEARXNG_URL;
    const res = await post({ query: "x" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("search_unavailable");
    expect(body.error.message).toMatch(/没有可用的搜索后端[\s\S]*网页搜索/);
    expect((await getUserById(userId))?.quotaUsed).toBe(0);
  });

  it("an unreachable backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = await post({ query: "x" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("search_unreachable");
    expect((await getUserById(userId))?.quotaUsed).toBe(0);
  });

  it("and records no usage row for a failed search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    await post({ query: "x" });
    expect(await listUsageByKey(keyId)).toHaveLength(0);
  });
});
