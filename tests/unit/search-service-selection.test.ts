/**
 * tests/unit/search-service-selection.test.ts
 *
 * A relay publishes what it can serve and lets the caller choose. The search
 * services used to be the one thing it did not publish: several rows could
 * exist, but only the first one by priority ever answered, and a client had
 * no way to find out that the others were there.
 *
 * These tests hold the three things that make that work:
 *
 *   1. **A service can be named.** `GET /v1/search/services` lists them by
 *      their client-visible name, and `POST /v1/search` takes that name.
 *   2. **Naming one means that one.** A name that is unknown, switched off, or
 *      unable to answer is refused **by name** — never answered by searching
 *      through a different service, because those rows carry their own price
 *      and a quiet substitution would change what the account is charged as
 *      well as which vendor answered.
 *   3. **The list is a promise.** Only the services that can answer are in it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { POST as searchPOST } from "@/app/api/v1/search/route";
import { GET as servicesGET } from "@/app/api/v1/search/services/route";
import { __resetDbForTest, run } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import {
  createSearchProvider,
  updateSearchProvider,
} from "@/lib/db/search-providers";

let plainKey = "";

const saved = {
  searxng: process.env.SEARXNG_URL,
  price: process.env.SEARCH_CREDITS_PER_CALL,
};

beforeEach(async () => {
  __resetDbForTest();
  process.env.SEARXNG_URL = "https://search.example";
  process.env.SEARCH_CREDITS_PER_CALL = "1";
  const user = await createUser({
    username: "selector",
    password: "pw-123456",
    role: "user",
    quotaType: "credits",
    quotaLimit: 100_000,
  });
  const key = await createApiKey({ userId: user.id, label: "test" });
  plainKey = key.plainKey;
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
  return searchPOST(
    new Request("https://api.example/v1/search", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function catalogue(key = plainKey): Promise<Response> {
  return servicesGET(
    new Request("https://api.example/v1/search/services", {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
}

async function twoServices() {
  const a = await createSearchProvider({
    name: "A",
    kind: "searxng",
    baseUrl: "https://a.example",
    serviceId: "alpha",
    priority: 1,
  });
  const b = await createSearchProvider({
    name: "B",
    kind: "searxng",
    baseUrl: "https://b.example",
    serviceId: "beta",
    priority: 2,
  });
  return { a, b };
}

describe("the catalogue of search services", () => {
  it("lists the services by the name a client uses to ask for one", async () => {
    await twoServices();

    const res = await catalogue();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string; name: string; kind: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((s) => s.id).sort()).toEqual(["alpha", "beta"]);
    expect(body.data[0].object).toBe("search_service");
    // There is no "default" in the catalogue: there is no default.
    expect("default" in body.data[0]).toBe(false);
  });

  it("refuses a request that names nobody, when there is more than one", async () => {
    // No default means no guessing: with two services on offer, a request that
    // names neither is refused, and the refusal lists the ones there are.
    await twoServices();
    const impl = stubSearch([]);

    const res = await post({ query: "q" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/alpha/);
    expect(body.error.message).toMatch(/beta/);
    expect(impl.mock.calls.length, "it searched with one of them anyway").toBe(0);
  });

  it("answers when there is only one, because there was no choice to make", async () => {
    await createSearchProvider({
      name: "Only",
      kind: "searxng",
      baseUrl: "https://only.example",
      serviceId: "only",
    });
    stubSearch([]);

    const res = await post({ query: "q" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service?: string };
    expect(body.service).toBe("only");
  });

  it("lists only the services that can answer", async () => {
    await twoServices();
    // A service that is switched off is not offered, and neither is one that
    // cannot work: offering it would be a promise the deployment cannot keep.
    const rows = await (await catalogue()).json() as { data: Array<{ id: string }> };
    expect(rows.data.length).toBe(2);

    // A keyed vendor with no key can only exist through a hand edit — the
    // save-time validation refuses to create one.
    run(
      `INSERT INTO search_providers
         (id, name, kind, base_url, encrypted_api_key, enabled, priority,
          service_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        "broken",
        "Keyless",
        "tavily",
        "https://tavily.example",
        "",
        1,
        5,
        "keyless",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );

    const after = (await (await catalogue()).json()) as { data: Array<{ id: string }> };
    expect(after.data.map((s) => s.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("needs a key, like every other paid endpoint", async () => {
    const res = await catalogue("sk-relay-0000000000000000000000000000000000000000");
    expect(res.status).toBe(401);
  });
});

describe("naming a service", () => {
  it("searches through the one that was named", async () => {
    await twoServices();
    const impl = stubSearch([]);

    const res = await post({ query: "q", service: "beta" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service?: string };
    // And the response says which one answered, the way a chat response names
    // the model it used.
    expect(body.service).toBe("beta");
    const [url] = impl.mock.calls[0] as unknown as [string];
    expect(url).toContain("b.example");
  });

  it("refuses a name nobody has, by name", async () => {
    await twoServices();
    stubSearch([]);

    const res = await post({ query: "q", service: "gamma" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/gamma/);
  });

  it("refuses a service that is switched off, and does not search through another one", async () => {
    const { b } = await twoServices();
    await updateSearchProvider(b.id, { enabled: false });
    const impl = stubSearch([]);

    const res = await post({ query: "q", service: "beta" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/beta|停用/);
    // The other service was right there and was not used: that is the whole
    // point of naming one.
    expect(impl.mock.calls.length, "it searched through another service").toBe(0);
  });
});
