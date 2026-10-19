/**
 * tests/integration/admin-search-routes.test.ts
 *
 * The two admin doors onto web search:
 *
 *   GET/PUT /api/admin/search       — the switch and the per-call price
 *   POST    /api/admin/search/test  — one query, not billed
 *
 * The panel is only as honest as these routes. The failure that matters is a
 * switch that saves but changes nothing, so the tests read the settings back
 * rather than trusting the response, and they run a real query through the
 * test route with a stubbed backend so "not billed" is observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createUser } from "@/lib/db/users";
import { getSettings } from "@/lib/db/settings";
import { getOne } from "@/lib/db/sqlite";

async function login(store: InMemoryCookieStore, id: string, role: "admin" | "user"): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = id;
  s.username = role;
  s.role = role;
  await s.save();
}

async function asAdmin(): Promise<void> {
  const admin = await createUser({ username: "admin", password: "pw-123456", role: "admin" });
  currentStore = new InMemoryCookieStore();
  await login(currentStore, admin.id, "admin");
}

const savedSearx = process.env.SEARXNG_URL;

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
  process.env.SEARXNG_URL = "https://search.example";
});

afterEach(() => {
  if (savedSearx === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = savedSearx;
  vi.unstubAllGlobals();
});

describe("GET /api/admin/search", () => {
  it("refuses an anonymous request", async () => {
    // A store with no session, not a null store: `getIronSession` needs the
    // cookie jar before it can answer "is anyone signed in".
    currentStore = new InMemoryCookieStore();
    const { GET } = await import("@/app/api/admin/search/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("refuses a non-admin", async () => {
    const user = await createUser({ username: "someone", password: "pw-123456", role: "user" });
    currentStore = new InMemoryCookieStore();
    await login(currentStore, user.id, "user");
    const { GET } = await import("@/app/api/admin/search/route");
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("reports the effective configuration", async () => {
    await asAdmin();
    const { GET } = await import("@/app/api/admin/search/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        config: { enabled: boolean; creditsPerCall: number; backendConfigured: boolean; backendName: string };
        stored: { enabled: boolean | null; creditsPerCall: number | null };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.config).toMatchObject({
      enabled: true,
      creditsPerCall: 1,
      backendConfigured: true,
      backendName: "SearXNG",
    });
    // Nothing saved yet: the panel must be able to tell a default from a choice.
    expect(body.data.stored).toEqual({ enabled: null, creditsPerCall: null });
  });
});

describe("PUT /api/admin/search", () => {
  it("saves the switch and the price, and reads them back", async () => {
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    const res = await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, creditsPerCall: 7 }),
      }),
    );
    expect(res.status).toBe(200);

    const settings = await getSettings();
    expect(settings.searchEnabled).toBe(false);
    expect(settings.searchCreditsPerCall).toBe(7);

    const body = (await res.json()) as { data: { config: { enabled: boolean; creditsPerCall: number } } };
    expect(body.data.config).toMatchObject({ enabled: false, creditsPerCall: 7 });
  });

  it("refuses a negative price", async () => {
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    const res = await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsPerCall: -1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses an empty update rather than writing nothing silently", async () => {
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    const res = await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/search/test", () => {
  it("runs a query without billing or writing usage", async () => {
    await asAdmin();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "Docs", url: "https://docs.example/", content: "Reference" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { POST } = await import("@/app/api/admin/search/test/route");
    const res = await POST(
      new Request("http://localhost/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "docs" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { results: Array<{ url: string }>; billed: boolean };
    };
    expect(body.data.results).toHaveLength(1);
    expect(body.data.billed).toBe(false);
    const row = getOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_logs WHERE capability = 'web.search'",
    );
    expect(row?.n).toBe(0);
  });

  it("still runs while the feature is switched off, because that is when it is needed", async () => {
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })),
    );

    const { POST } = await import("@/app/api/admin/search/test/route");
    const res = await POST(
      new Request("http://localhost/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "docs" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("says the backend is missing instead of pretending", async () => {
    await asAdmin();
    delete process.env.SEARXNG_URL;
    const { POST } = await import("@/app/api/admin/search/test/route");
    const res = await POST(
      new Request("http://localhost/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "docs" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
