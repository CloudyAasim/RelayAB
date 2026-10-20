/**
 * tests/unit/search-openai-compat.test.ts
 *
 * Is `/v1/search` an OpenAI-compatible endpoint?
 *
 * The claim on the tin is that this gateway speaks OpenAI's shapes, and the
 * search endpoint is part of that surface. A client that already handles
 * OpenAI's errors should not need a second error parser for it, so the
 * questions here are concrete:
 *
 *  - does a failure come back as `{ error: { message, type, code } }` with a
 *    `type` from OpenAI's taxonomy?
 *  - is an exhausted balance `insufficient_quota` rather than
 *    `rate_limit_error`? A client that backs off and retries a 429 will retry
 *    forever, and an empty balance is not rate limiting.
 *  - does the balance ride in the `x-ratelimit-*` headers, the way OpenAI
 *    reports it, instead of a body field nobody reads?
 *
 * These are assertions about the *contract*, so they are written as such: the
 * taxonomy comes from the same function the proxy uses, and the assertions
 * name the type rather than restating a table.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { POST, GET } from "@/app/api/v1/search/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser, getUserById, incrementUserQuotaUsed } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { openAiErrorType } from "@/lib/proxy/errors";

let userId = "";
let plainKey = "";

const saved = { searxng: process.env.SEARXNG_URL, price: process.env.SEARCH_CREDITS_PER_CALL };

beforeEach(async () => {
  __resetDbForTest();
  process.env.SEARXNG_URL = "https://search.example";
  process.env.SEARCH_CREDITS_PER_CALL = "1";
  const user = await createUser({
    username: "searcher",
    password: "pw-123456",
    role: "user",
    quotaType: "credits",
    quotaLimit: 100_000,
  });
  userId = user.id;
  plainKey = (await createApiKey({ userId, label: "test" })).plainKey;
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

function stubSearch(results: Array<{ title: string; url: string; content: string }>, status = 200) {
  const impl = vi.fn(async () =>
    new Response(JSON.stringify({ results }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", impl);
  return impl;
}

function post(body: unknown, key: string | null = plainKey): Promise<Response> {
  return POST(
    new Request("https://api.example/v1/search", {
      method: "POST",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

interface ErrorBody {
  error: { message: string; type: string; code: string };
}

describe("the success shape", () => {
  it("carries an object, the results and what it cost", async () => {
    stubSearch([{ title: "Docs", url: "https://docs.example/", content: "Reference" }]);
    const res = await post({ query: "docs" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      object: string;
      query: string;
      results: Array<{ title: string; url: string; snippet: string }>;
      credits: number;
    };
    // `object` is how a client tells what it got back, the same way every other
    // response on this gateway names itself.
    expect(body.object).toBe("search");
    expect(body.results[0]).toEqual({
      title: "Docs",
      url: "https://docs.example/",
      snippet: "Reference",
    });
    expect(body.credits).toBe(1);
  });

  it("reports the balance in the x-ratelimit-* headers, not in the body", async () => {
    stubSearch([{ title: "Docs", url: "https://docs.example/", content: "Reference" }]);
    const res = await post({ query: "docs" });
    expect(res.headers.get("x-ratelimit-limit")).toBe("100000");
    // One 积分 is 1000 storage units, so the remaining balance drops by 1000.
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99000");
    expect(res.headers.get("x-ratelimit-unit")).toBe("credits");
  });

  it("works over GET as well, and bills the same", async () => {
    stubSearch([{ title: "Docs", url: "https://docs.example/", content: "Reference" }]);
    const res = await GET(
      new Request("https://api.example/v1/search?q=docs&limit=2", {
        headers: { authorization: `Bearer ${plainKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; query: string };
    expect(body.object).toBe("search");
    expect(body.query).toBe("docs");
    expect((await getUserById(userId))?.quotaUsed).toBe(1000);
  });
});

describe("the error shape", () => {
  async function errorOf(res: Response): Promise<ErrorBody> {
    const body = (await res.json()) as ErrorBody;
    expect(body.error, "the body is not an OpenAI error envelope").toBeTruthy();
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.type).toBe("string");
    expect(typeof body.error.code).toBe("string");
    return body;
  }

  it("an empty query is an invalid request", async () => {
    const res = await post({ query: "" });
    expect(res.status).toBe(400);
    const body = await errorOf(res);
    expect(body.error.type).toBe(openAiErrorType(400, body.error.code));
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("a missing key is an authentication error", async () => {
    const res = await post({ query: "x" }, null);
    expect(res.status).toBe(401);
    const body = await errorOf(res);
    expect(body.error.type).toBe("authentication_error");
  });

  it("an exhausted balance is insufficient_quota, not rate_limit_error", async () => {
    // The distinction a client acts on: a 429 it should back off from, or a 429
    // it should stop calling because the account has no money left. Both are
    // 429, so only `type` can tell them apart.
    const user = await getUserById(userId);
    await incrementUserQuotaUsed(userId, user!.quotaLimit);

    const res = await post({ query: "x" });
    expect(res.status).toBe(429);
    const body = await errorOf(res);
    expect(body.error.code).toBe("quota_exceeded_credits");
    expect(body.error.type).toBe("insufficient_quota");
    expect(body.error.type).not.toBe("rate_limit_error");
  });

  it("an upstream that throttles is a rate limit", async () => {
    stubSearch([], 429);
    const res = await post({ query: "x" });
    expect(res.status).toBe(429);
    const body = await errorOf(res);
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("no backend at all is a server-side problem", async () => {
    delete process.env.SEARXNG_URL;
    const res = await post({ query: "x" });
    expect(res.status).toBe(503);
    const body = await errorOf(res);
    expect(body.error.code).toBe("search_unavailable");
    expect(body.error.type).toBe("server_error");
  });

  it("an upstream that is down is a server-side problem too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = await post({ query: "x" });
    expect(res.status).toBe(502);
    const body = await errorOf(res);
    expect(body.error.code).toBe("search_unreachable");
    expect(body.error.type).toBe("server_error");
  });
});
