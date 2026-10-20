/**
 * tests/integration/admin-search-provider-routes.test.ts
 *
 * The CRUD doors for search backends, plus the one route whose whole purpose is
 * diagnosis: "test this provider", which must run even when the provider is
 * disabled and must never bill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest, getOne } from "@/lib/db/sqlite";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import {
  createSearchProvider,
  getSearchProviderById,
  updateSearchProvider,
} from "@/lib/db/search-providers";

import { GET as listGET, POST as createPOST } from "@/app/api/admin/search-providers/route";
import {
  DELETE as oneDELETE,
  GET as oneGET,
  PATCH as onePATCH,
} from "@/app/api/admin/search-providers/[id]/route";
import { POST as testPOST } from "@/app/api/admin/search-providers/[id]/test/route";

let adminId = "";

async function login(store: InMemoryCookieStore, id: string, role: "admin" | "user"): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = id;
  s.username = role;
  s.role = role;
  await s.save();
}

async function asAdmin(): Promise<void> {
  const admin = await createUser({ username: "admin", password: "pw-123456", role: "admin" });
  adminId = admin!.id;
  // A key the account can be charged through: a usage row hangs off a key, so
  // an account with no key has nowhere to put the spend.
  await createApiKey({ userId: adminId, label: "panel" });
  currentStore = new InMemoryCookieStore();
  await login(currentStore, admin.id, "admin");
}

async function asUser(): Promise<void> {
  const user = await createUser({ username: "someone", password: "pw-123456", role: "user" });
  currentStore = new InMemoryCookieStore();
  await login(currentStore, user.id, "user");
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function json(body: unknown): Request {
  return new Request("http://localhost/api/admin/search-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorization", () => {
  it("refuses anonymous access on every method", async () => {
    currentStore = new InMemoryCookieStore();
    expect((await listGET()).status).toBe(403);
    expect((await createPOST(json({ name: "x", kind: "searxng", baseUrl: "https://a.example" }))).status).toBe(403);
    expect((await oneGET(new Request("http://localhost"), ctx("x"))).status).toBe(403);
    expect((await onePATCH(json({ name: "y" }), ctx("x"))).status).toBe(403);
    expect((await oneDELETE(new Request("http://localhost"), ctx("x"))).status).toBe(403);
    expect((await testPOST(json({ query: "q" }), ctx("x"))).status).toBe(403);
  });

  it("refuses a signed-in non-admin", async () => {
    await asUser();
    expect((await listGET()).status).toBe(403);
    expect((await createPOST(json({ name: "x", kind: "searxng", baseUrl: "https://a.example" }))).status).toBe(403);
  });
});

describe("GET /api/admin/search-providers", () => {
  it("lists rows without any ciphertext", async () => {
    await asAdmin();
    await createSearchProvider({ name: "T", kind: "tavily", apiKey: "tvly-secret" });
    await createSearchProvider({ name: "S", kind: "searxng", baseUrl: "https://s.example" });

    const res = await listGET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("tvly-secret");
    expect(text).not.toContain("encryptedApiKey");

    const body = JSON.parse(text) as {
      data: { providers: Array<{ name: string; hasApiKey: boolean }> };
    };
    expect(body.data.providers.map((p) => p.name)).toEqual(["S", "T"]);
    expect(body.data.providers.find((p) => p.name === "T")?.hasApiKey).toBe(true);
    expect(body.data.providers.find((p) => p.name === "S")?.hasApiKey).toBe(false);
  });
});

describe("POST /api/admin/search-providers", () => {
  it("creates a provider from the form body", async () => {
    await asAdmin();
    const res = await createPOST(
      json({
        name: "Local",
        kind: "searxng",
        baseUrl: "https://s.example",
        priority: 3,
        creditsPerCall: 4,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        provider: {
          id: string;
          name: string;
          priority: number;
          enabled: boolean;
          creditsPerCall: number;
        };
      };
    };
    expect(body.data.provider).toMatchObject({
      name: "Local",
      priority: 3,
      enabled: true,
      creditsPerCall: 4,
    });
    expect(await getSearchProviderById(body.data.provider.id)).not.toBeNull();
  });

  it("rejects an unknown kind and unknown fields", async () => {
    await asAdmin();
    expect((await createPOST(json({ name: "x", kind: "google" }))).status).toBe(400);
    expect(
      (await createPOST(json({ name: "x", kind: "searxng", baseUrl: "https://s.example", extra: 1 })))
        .status,
    ).toBe(400);
  });

  it("rejects a SearXNG row with no address", async () => {
    await asAdmin();
    const res = await createPOST(json({ name: "x", kind: "searxng" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/base URL/i);
  });

  it("rejects a keyed kind with no key", async () => {
    await asAdmin();
    expect((await createPOST(json({ name: "x", kind: "brave" }))).status).toBe(400);
  });

  it("rejects a negative price before it reaches the repository", async () => {
    await asAdmin();
    const res = await createPOST(
      json({ name: "x", kind: "searxng", baseUrl: "https://s.example", creditsPerCall: -1 }),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET/PATCH/DELETE /api/admin/search-providers/[id]", () => {
  it("reads, edits, and deletes one row", async () => {
    await asAdmin();
    const row = await createSearchProvider({ name: "T", kind: "tavily", apiKey: "tvly-secret" });

    const read = await oneGET(new Request("http://localhost"), ctx(row.id));
    expect(read.status).toBe(200);

    const patched = await onePATCH(
      json({ name: "T2", enabled: false, creditsPerCall: 6 }),
      ctx(row.id),
    );
    expect(patched.status).toBe(200);
    const stored = await getSearchProviderById(row.id);
    expect(stored?.name).toBe("T2");
    expect(stored?.enabled).toBe(false);
    expect(stored?.creditsPerCall).toBe(6);
    // A PATCH without a key must not erase the stored credential.
    expect(stored?.encryptedApiKey).toBe(row.encryptedApiKey);

    const removed = await oneDELETE(new Request("http://localhost"), ctx(row.id));
    expect(removed.status).toBe(200);
    expect(await getSearchProviderById(row.id)).toBeNull();
  });

  it("answers 404 for an unknown id on every method", async () => {
    await asAdmin();
    expect((await oneGET(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
    expect((await onePATCH(json({ name: "x" }), ctx("nope"))).status).toBe(404);
    expect((await oneDELETE(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
    expect((await testPOST(json({ query: "q" }), ctx("nope"))).status).toBe(404);
  });

  it("refuses an edit that would leave a keyed row unusable", async () => {
    await asAdmin();
    const row = await createSearchProvider({ name: "S", kind: "searxng", baseUrl: "https://s.example" });
    const res = await onePATCH(json({ kind: "tavily" }), ctx(row.id));
    expect(res.status).toBe(400);
    expect((await getSearchProviderById(row.id))?.kind).toBe("searxng");
  });
});

describe("POST /api/admin/search-providers/[id]/test", () => {
  it("queries exactly that provider, even when it is disabled, and bills the account", async () => {
    await asAdmin();
    const row = await createSearchProvider({
      name: "Off",
      kind: "searxng",
      baseUrl: "https://off.example",
    });
    await updateSearchProvider(row.id, { enabled: false });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          results: [{ title: "Docs", url: "https://docs.example/", content: "Reference" }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await testPOST(json({ query: "docs", limit: 3 }), ctx(row.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { providerId: string; results: unknown[]; billed: boolean; credits: number };
    };
    expect(body.data.providerId).toBe(row.id);
    expect(body.data.results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The provider's own address, not some other configured backend.
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("off.example");

    // A test is not a free ride on a paid API: the operator pays the vendor
    // either way, so the account pays too.
    expect(body.data.billed).toBe(true);
    expect(body.data.credits).toBe(1);
    const usage = getOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM usage_logs WHERE capability = 'web.search'",
    );
    expect(usage?.n).toBe(1);
    expect((await getUserById(adminId))?.quotaUsed).toBe(1000);
  });

  it("says the row cannot be used instead of guessing", async () => {
    await asAdmin();
    const broken = await createSearchProvider({ name: "Bad", kind: "tavily", apiKey: "k" });
    // Damage it the way a rotated master key would: ciphertext that will not
    // decrypt. Writing directly is the only way to reach this state.
    const { run } = await import("@/lib/db/sqlite");
    run("UPDATE search_providers SET encrypted_api_key = 'not-a-ciphertext' WHERE id = ?", [broken.id]);

    const res = await testPOST(json({ query: "q" }), ctx(broken.id));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  it("rejects an empty query", async () => {
    await asAdmin();
    const row = await createSearchProvider({ name: "S", kind: "searxng", baseUrl: "https://s.example" });
    expect((await testPOST(json({ query: "   " }), ctx(row.id))).status).toBe(400);
  });
});
