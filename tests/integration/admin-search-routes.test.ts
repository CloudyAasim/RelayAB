/**
 * tests/integration/admin-search-routes.test.ts
 *
 * The two admin doors onto web search:
 *
 *   GET/PUT /api/admin/search       — the environment fallback's price
 *   POST    /api/admin/search/test  — one query, billed like a real search
 *
 * The panel is only as honest as these routes. The failure that matters is a
 * setting that saves but changes nothing, so the tests read the settings back
 * rather than trusting the response, and they run a real query through the
 * test route with a stubbed backend so "billed" is observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { getSettings } from "@/lib/db/settings";
import { getOne } from "@/lib/db/sqlite";

async function login(store: InMemoryCookieStore, id: string, role: "admin" | "user"): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = id;
  s.username = role;
  s.role = role;
  await s.save();
}

let adminId = "";

async function asAdmin(): Promise<void> {
  const admin = await createUser({
    username: "admin",
    password: "pw-123456",
    role: "admin",
    quotaType: "credits",
    // 100 积分, in 0.001-积分 units. A test is billed like a real search, so
    // the account has to be able to pay for one.
    quotaLimit: 100_000,
  });
  adminId = admin!.id;
  // A key the account can be charged through: a usage row hangs off a key, so
  // an account with no key has nowhere to put the spend.
  await createApiKey({ userId: adminId, label: "panel" });
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
        stored: { creditsPerCall: number | null };
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
    expect(body.data.stored).toEqual({ creditsPerCall: null });
  });
});

describe("PUT /api/admin/search", () => {
  it("saves the environment fallback's price, and reads it back", async () => {
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    const res = await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsPerCall: 7 }),
      }),
    );
    expect(res.status).toBe(200);

    const settings = await getSettings();
    expect(settings.searchCreditsPerCall).toBe(7);

    const body = (await res.json()) as { data: { config: { creditsPerCall: number } } };
    expect(body.data.config).toMatchObject({ creditsPerCall: 7 });
  });

  it("refuses the old feature-wide switch rather than ignoring it", async () => {
    // The switch is gone: the provider rows are what says whether search runs.
    // Accepting the field and ignoring it would be the worst of both — the
    // panel would take it, and nothing would change.
    await asAdmin();
    const { PUT } = await import("@/app/api/admin/search/route");
    const res = await PUT(
      new Request("http://localhost/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(400);
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
  it("runs a query and bills it like a real search", async () => {
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
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      data: { results: Array<{ url: string }>; billed: boolean; credits: number };
    };
    expect(body.data.results).toHaveLength(1);
    expect(body.data.billed).toBe(true);
    expect(body.data.credits).toBe(1);

    // The point of the change: a test is not a free ride on a paid API. The
    // operator pays the vendor either way, so the account pays too.
    const row = getOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_logs WHERE capability = 'web.search'",
    );
    expect(row?.n).toBe(1);
    expect((await getUserById(adminId))?.quotaUsed).toBe(1000);
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

  it("refuses to test when the balance cannot cover the call", async () => {
    // The same rule the public endpoint obeys: a search that cannot be paid
    // for does not happen. The vendor is never called, and nothing is charged.
    await asAdmin();
    const { updateUser } = await import("@/lib/db/users");
    await updateUser(adminId, { quotaUsed: 99_900 });
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ results: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", impl);

    const { POST } = await import("@/app/api/admin/search/test/route");
    const res = await POST(
      new Request("http://localhost/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "docs" }),
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("quota_exceeded_credits");
    expect(body.error.message).toMatch(/积分余额不足/);
    expect(impl).not.toHaveBeenCalled();
    expect((await getUserById(adminId))?.quotaUsed).toBe(99_900);
  });

  it("refuses to test an account with no key to charge", async () => {    // A usage row hangs off a key, so an account with no key has nowhere to
    // put the spend. Refusing is the honest answer: charging for something no
    // report would ever show is the failure mode this is here to prevent.
    const { __resetDbForTest } = await import("@/lib/db/sqlite");
    __resetDbForTest();
    const admin = await createUser({ username: "admin", password: "pw-123456", role: "admin" });
    currentStore = new InMemoryCookieStore();
    await login(currentStore, admin!.id, "admin");

    const { POST } = await import("@/app/api/admin/search/test/route");
    const res = await POST(
      new Request("http://localhost/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "docs" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_key_to_charge");
    expect((await getUserById(admin!.id))?.quotaUsed).toBe(0);
  });
});
