/**
 * tests/integration/search-providers-repo.test.ts
 *
 * The search-provider repository: CRUD, ordering, and the two things that
 * matter about a stored credential — it is encrypted at rest and a blank edit
 * does not erase it.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import {
  createSearchProvider,
  deleteSearchProvider,
  getSearchProviderById,
  listSearchProviders,
  SearchProviderValidationError,
  toPublicSearchProvider,
  updateSearchProvider,
} from "@/lib/db/search-providers";

beforeEach(() => {
  __resetDbForTest();
});

describe("create", () => {
  it("stores a SearXNG row without a key", async () => {
    const row = await createSearchProvider({
      name: "Local",
      kind: "searxng",
      baseUrl: "http://relay-search.web:8080",
    });
    expect(row.enabled).toBe(true);
    expect(row.priority).toBe(1);
    expect(row.encryptedApiKey).toBe("");
    expect(toPublicSearchProvider(row).hasApiKey).toBe(false);
  });

  it("requires an address for SearXNG", async () => {
    await expect(
      createSearchProvider({ name: "Local", kind: "searxng" }),
    ).rejects.toBeInstanceOf(SearchProviderValidationError);
  });

  it("requires a key for Tavily and Brave", async () => {
    for (const kind of ["tavily", "brave"] as const) {
      await expect(
        createSearchProvider({ name: kind, kind }),
      ).rejects.toBeInstanceOf(SearchProviderValidationError);
    }
  });

  it("encrypts the key and never returns it", async () => {
    const row = await createSearchProvider({ name: "T", kind: "tavily", apiKey: "tvly-secret" });
    expect(row.encryptedApiKey).not.toBe("tvly-secret");
    const pub = toPublicSearchProvider(row);
    expect(pub.hasApiKey).toBe(true);
    expect("encryptedApiKey" in pub).toBe(false);
  });
});

describe("list", () => {
  it("orders by priority then name", async () => {
    await createSearchProvider({ name: "B", kind: "searxng", baseUrl: "https://b.example", priority: 2 });
    await createSearchProvider({ name: "A", kind: "searxng", baseUrl: "https://a.example", priority: 1 });
    await createSearchProvider({ name: "C", kind: "searxng", baseUrl: "https://c.example", priority: 2 });
    const rows = await listSearchProviders();
    expect(rows.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("enabledOnly filters disabled rows", async () => {
    const on = await createSearchProvider({ name: "On", kind: "searxng", baseUrl: "https://a.example" });
    const off = await createSearchProvider({ name: "Off", kind: "searxng", baseUrl: "https://b.example" });
    await updateSearchProvider(off.id, { enabled: false });
    const rows = await listSearchProviders({ enabledOnly: true });
    expect(rows.map((r) => r.id)).toEqual([on.id]);
  });
});

describe("update", () => {
  it("keeps the stored key when the edit leaves it blank", async () => {
    const row = await createSearchProvider({ name: "T", kind: "tavily", apiKey: "tvly-secret" });
    const before = row.encryptedApiKey;
    const updated = await updateSearchProvider(row.id, { name: "T2" });
    expect(updated?.name).toBe("T2");
    expect(updated?.encryptedApiKey).toBe(before);
  });

  it("re-encrypts when a new key is supplied", async () => {
    const row = await createSearchProvider({ name: "T", kind: "tavily", apiKey: "tvly-secret" });
    const updated = await updateSearchProvider(row.id, { apiKey: "tvly-other" });
    expect(updated?.encryptedApiKey).not.toBe(row.encryptedApiKey);
  });

  it("refuses to switch a keyless row to a keyed kind", async () => {
    const row = await createSearchProvider({
      name: "S",
      kind: "searxng",
      baseUrl: "https://s.example",
    });
    await expect(updateSearchProvider(row.id, { kind: "tavily" })).rejects.toBeInstanceOf(
      SearchProviderValidationError,
    );
  });

  it("returns null for an unknown id", async () => {
    expect(await updateSearchProvider("nope", { name: "x" })).toBeNull();
  });
});

describe("delete", () => {
  it("removes a row and reports whether it existed", async () => {
    const row = await createSearchProvider({ name: "S", kind: "searxng", baseUrl: "https://s.example" });
    expect(await deleteSearchProvider(row.id)).toBe(true);
    expect(await getSearchProviderById(row.id)).toBeNull();
    expect(await deleteSearchProvider(row.id)).toBe(false);
  });
});
