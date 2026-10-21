/**
 * tests/unit/search-provider-resolution.test.ts
 *
 * Which backend answers, and with what it is attributed.
 *
 * The rule under test is the one that makes disabling meaningful: the provider
 * table is authoritative **once it has a row**. An empty table falls back to
 * the environment so an upgrade keeps working; a table with every row disabled
 * must not fall back, or "off" would not mean off.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __resetDbForTest, run } from "@/lib/db/sqlite";
import {
  createSearchProvider,
  setDefaultSearchProvider,
  updateSearchProvider,
} from "@/lib/db/search-providers";
import {
  activeSearchBackendInfo,
  resolveActiveSearchBackend,
  resolveSearchBackendByServiceId,
  searchActive,
} from "@/lib/search/resolve";

const saved = {
  searxng: process.env.SEARXNG_URL,
  tavily: process.env.TAVILY_API_KEY,
  brave: process.env.BRAVE_SEARCH_API_KEY,
};

beforeEach(() => {
  __resetDbForTest();
  delete process.env.SEARXNG_URL;
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
});

afterEach(() => {
  for (const [name, value] of [
    ["SEARXNG_URL", saved.searxng],
    ["TAVILY_API_KEY", saved.tavily],
    ["BRAVE_SEARCH_API_KEY", saved.brave],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("with no provider rows", () => {
  it("falls back to the environment, as every existing deployment expects", async () => {
    process.env.SEARXNG_URL = "http://relay-search.web:8080";
    const backend = await resolveActiveSearchBackend();
    expect(backend?.source).toBe("env");
    expect(backend?.usageProviderId).toBe("searxng");
    expect(backend?.describe).toBe("SearXNG");

    const info = await activeSearchBackendInfo();
    expect(info).toMatchObject({
      configured: true,
      source: "env",
      kind: "searxng",
      baseUrl: "http://relay-search.web:8080",
      // No row, no row price: the feature-wide fallback price applies.
      creditsPerCall: null,
    });
  });

  it("reports unconfigured when the environment is empty too", async () => {
    expect(await resolveActiveSearchBackend()).toBeNull();
    expect((await activeSearchBackendInfo()).configured).toBe(false);
  });
});

describe("with provider rows", () => {
  it("uses the database row and attributes the call to its id", async () => {
    process.env.SEARXNG_URL = "https://env.example";
    const row = await createSearchProvider({
      name: "Local",
      kind: "searxng",
      baseUrl: "https://db.example",
      priority: 1,
      creditsPerCall: 4,
    });

    const backend = await resolveActiveSearchBackend();
    expect(backend?.source).toBe("db");
    expect(backend?.usageProviderId).toBe(row.id);
    expect(backend?.describe).toBe("Local");
    expect(backend?.baseUrl).toBe("https://db.example");
    // The price travels with the backend, so billing cannot pick another one.
    expect(backend?.creditsPerCall).toBe(4);

    const info = await activeSearchBackendInfo();
    expect(info).toMatchObject({
      source: "db",
      name: "Local",
      usageProviderId: row.id,
      creditsPerCall: 4,
    });
  });

  it("takes the first enabled row by priority, then name", async () => {
    await createSearchProvider({ name: "B", kind: "searxng", baseUrl: "https://b.example", priority: 2 });
    const first = await createSearchProvider({
      name: "A",
      kind: "searxng",
      baseUrl: "https://a.example",
      priority: 1,
    });
    const backend = await resolveActiveSearchBackend();
    expect(backend?.usageProviderId).toBe(first.id);
  });

  it("a marked default overrides the priority order", async () => {
    // The marker is the way to say "this one, whatever the numbers say".
    await createSearchProvider({ name: "A", kind: "searxng", baseUrl: "https://a.example", priority: 1 });
    const b = await createSearchProvider({ name: "B", kind: "searxng", baseUrl: "https://b.example", priority: 9 });
    await setDefaultSearchProvider(b.id);
    const backend = await resolveActiveSearchBackend();
    expect(backend?.usageProviderId).toBe(b.id);
  });

  it("does not fall back to another service when the one that answers cannot", async () => {
    // This is the change that matters: the rows carry their **own price**, so a
    // quiet substitution would change what the account is charged as well as
    // which vendor answered. The service that was chosen is the service that
    // answers; when it cannot, the request fails with the reason.
    const broken = await createSearchProvider({
      name: "Broken",
      kind: "tavily",
      baseUrl: "https://tavily.example",
      priority: 1,
      apiKey: "tvly-secret",
    });
    await createSearchProvider({ name: "Good", kind: "searxng", baseUrl: "https://good.example", priority: 2 });

    // A key that cannot decrypt is the case the old resolver skipped in
    // silence: the row looked perfectly healthy in the panel.
    run("UPDATE search_providers SET encrypted_api_key = 'not-encrypted' WHERE id = ?", [broken.id]);

    expect(await resolveActiveSearchBackend()).toBeNull();
    const info = await activeSearchBackendInfo();
    expect(info.configured).toBe(false);
    // And the reason says which service and why.
    expect(info.providerId).toBe(broken.id);
    expect(info.unusableReason).toMatch(/解密/);
  });

  it("says the name of a service a caller asked for, and refuses one it cannot have", async () => {
    const row = await createSearchProvider({
      name: "Local",
      kind: "searxng",
      baseUrl: "https://db.example",
      serviceId: "local-search",
    });

    const named = await resolveSearchBackendByServiceId("local-search");
    expect(named.backend?.usageProviderId).toBe(row.id);
    expect(named.problem).toBeNull();

    // A name nobody has.
    const unknown = await resolveSearchBackendByServiceId("nope");
    expect(unknown.backend).toBeNull();
    expect(unknown.problem).toMatch(/nope/);

    // A name that is switched off: refused by name, not answered by another.
    await updateSearchProvider(row.id, { enabled: false });
    const off = await resolveSearchBackendByServiceId("local-search");
    expect(off.backend).toBeNull();
    expect(off.problem).toMatch(/停用/);
  });

  it("skips a disabled row", async () => {
    const off = await createSearchProvider({
      name: "Off",
      kind: "searxng",
      baseUrl: "https://off.example",
      priority: 1,
    });
    const on = await createSearchProvider({
      name: "On",
      kind: "searxng",
      baseUrl: "https://on.example",
      priority: 2,
    });
    await updateSearchProvider(off.id, { enabled: false });
    const backend = await resolveActiveSearchBackend();
    expect(backend?.usageProviderId).toBe(on.id);
  });

  it("does not fall back to the environment when every row is disabled", async () => {
    process.env.SEARXNG_URL = "https://env.example";
    const row = await createSearchProvider({ name: "Only", kind: "searxng", baseUrl: "https://db.example" });
    await updateSearchProvider(row.id, { enabled: false });

    expect(await resolveActiveSearchBackend()).toBeNull();
    expect((await activeSearchBackendInfo()).configured).toBe(false);
  });

  it("does not skip past a service that cannot work", async () => {
    // A keyed kind with no stored key can exist only through a hand edit or a
    // migrated row. It used to be **skipped**: the resolver walked the rows,
    // passed over the one that could not answer, and served from the next one.
    //
    // That was a silent substitution of one vendor for another — and these
    // rows carry their own price, so it changed what the account was charged
    // as well. Now the service that was chosen is the service that answers,
    // and this one says why it cannot.
    run(
      `INSERT INTO search_providers
         (id, name, kind, base_url, encrypted_api_key, enabled, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["bad", "Broken", "tavily", "", "", 1, 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    await createSearchProvider({
      name: "Good",
      kind: "searxng",
      baseUrl: "https://good.example",
      priority: 1,
    });

    expect(await resolveActiveSearchBackend()).toBeNull();
    const info = await activeSearchBackendInfo();
    expect(info.configured).toBe(false);
    expect(info.unusableReason).toBeTruthy();
  });

  it("serves the first service that can, when the broken one is not the first", async () => {
    // The other half of the rule: a service that cannot answer is not
    // *chosen* — it is only chosen when nothing better comes first. A broken
    // row further down the order is simply never reached.
    await createSearchProvider({
      name: "Good",
      kind: "searxng",
      baseUrl: "https://good.example",
      priority: 0,
    });
    run(
      `INSERT INTO search_providers
         (id, name, kind, base_url, encrypted_api_key, enabled, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["bad", "Broken", "tavily", "", "", 1, 9, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    const backend = await resolveActiveSearchBackend();
    expect(backend?.describe).toBe("Good");
  });
});

describe("searchActive", () => {
  it("returns the provider id used for the call", async () => {
    const row = await createSearchProvider({
      name: "Local",
      kind: "searxng",
      baseUrl: "https://db.example",
    });
    const outcome = await searchActive("q", {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(outcome.providerId).toBe(row.id);
    expect(outcome.provider).toBe("searxng");
  });
});
