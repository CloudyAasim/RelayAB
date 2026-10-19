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
import { createSearchProvider, updateSearchProvider } from "@/lib/db/search-providers";
import {
  activeSearchBackendInfo,
  resolveActiveSearchBackend,
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

  it("skips a row that cannot work instead of failing the request", async () => {
    // A keyed kind with no stored key can exist only through a hand edit or a
    // migrated row; it must be skipped, not chosen and then fail at call time.
    run(
      `INSERT INTO search_providers
         (id, name, kind, base_url, encrypted_api_key, enabled, priority, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["bad", "Broken", "tavily", "", "", 1, 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    const good = await createSearchProvider({
      name: "Good",
      kind: "searxng",
      baseUrl: "https://good.example",
      priority: 1,
    });
    const backend = await resolveActiveSearchBackend();
    expect(backend?.usageProviderId).toBe(good.id);
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
