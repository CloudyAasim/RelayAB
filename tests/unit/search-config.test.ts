/**
 * tests/unit/search-config.test.ts
 *
 * Where the search settings live and which source wins.
 *
 * Three readers depend on this: `/v1/search`, the assistant's `web_search`
 * tool, and the admin panel. If they resolve the price differently, the panel
 * shows one number and the bill uses another — the sort of disagreement that
 * is invisible until someone reconciles a usage table.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { loadSearchConfig, envSearchCredits, DEFAULT_SEARCH_CREDITS } from "@/lib/search/config";
import { createSearchProvider, updateSearchProvider } from "@/lib/db/search-providers";

const saved = {
  searxng: process.env.SEARXNG_URL,
  price: process.env.SEARCH_CREDITS_PER_CALL,
};

beforeEach(() => {
  __resetDbForTest();
  delete process.env.SEARXNG_URL;
  delete process.env.SEARCH_CREDITS_PER_CALL;
});

afterEach(() => {
  for (const [name, value] of [
    ["SEARXNG_URL", saved.searxng],
    ["SEARCH_CREDITS_PER_CALL", saved.price],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("stored settings", () => {
  it("round-trips the switch and the price", async () => {
    await updateSettings({ searchEnabled: false, searchCreditsPerCall: 4 });
    const settings = await getSettings();
    expect(settings.searchEnabled).toBe(false);
    expect(settings.searchCreditsPerCall).toBe(4);
  });

  it("distinguishes absent from false", async () => {
    // Absent means "on" for an upgraded deployment; false means somebody
    // turned it off. Collapsing the two would silently enable a feature an
    // operator had switched off.
    expect((await getSettings()).searchEnabled).toBeUndefined();
    await updateSettings({ searchEnabled: true });
    expect((await getSettings()).searchEnabled).toBe(true);
    await updateSettings({ searchEnabled: false });
    expect((await getSettings()).searchEnabled).toBe(false);
  });

  it("ignores a corrupt stored price instead of billing NaN", async () => {
    // The column is TEXT; a hand edit should fall back, not turn every call
    // into a zero-credit one.
    const { run } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES (?, ?)", ["searchCreditsPerCall", "banana"]);
    const settings = await getSettings();
    expect(settings.searchCreditsPerCall).toBeUndefined();
  });
});

describe("the effective configuration", () => {
  it("defaults to on, one credit, and no backend", async () => {
    const config = await loadSearchConfig();
    expect(config.enabled).toBe(true);
    expect(config.creditsPerCall).toBe(DEFAULT_SEARCH_CREDITS);
    expect(config.backendConfigured).toBe(false);
    expect(config.backendName).toBeNull();
  });

  it("reads the price from the environment when nothing is saved", async () => {
    process.env.SEARCH_CREDITS_PER_CALL = "3";
    expect((await loadSearchConfig()).creditsPerCall).toBe(3);
  });

  it("lets the saved price beat the environment", async () => {
    await updateSettings({ searchCreditsPerCall: 2 });
    process.env.SEARCH_CREDITS_PER_CALL = "9";
    expect((await loadSearchConfig()).creditsPerCall).toBe(2);
  });

  it("a saved zero is a real price, not an absent one", async () => {
    await updateSettings({ searchCreditsPerCall: 0 });
    process.env.SEARCH_CREDITS_PER_CALL = "5";
    expect((await loadSearchConfig()).creditsPerCall).toBe(0);
  });

  it("reports the SearXNG backend and its internal address", async () => {
    process.env.SEARXNG_URL = "http://relay-search.web:8080";
    const config = await loadSearchConfig();
    expect(config.backendConfigured).toBe(true);
    expect(config.backendName).toBe("SearXNG");
    expect(config.backendUrl).toBe("http://relay-search.web:8080");
  });

  it("prefers a stored provider over the environment and says where it came from", async () => {
    process.env.SEARXNG_URL = "https://env.example";
    const row = await createSearchProvider({
      name: "Local SearXNG",
      kind: "searxng",
      baseUrl: "https://db.example",
      priority: 1,
    });

    const config = await loadSearchConfig();
    expect(config.backendConfigured).toBe(true);
    expect(config.backendName).toBe("Local SearXNG");
    expect(config.backendUrl).toBe("https://db.example");
    expect(config.backendSource).toBe("db");
    expect(config.backendKind).toBe("searxng");
    expect(config.backendProviderId).toBe(row.id);
  });

  it("reports the environment as the source only while no row exists", async () => {
    process.env.SEARXNG_URL = "https://env.example";
    const config = await loadSearchConfig();
    expect(config.backendSource).toBe("env");
    expect(config.backendProviderId).toBe("searxng");
    // No row to carry a price, so the fallback setting is what bills.
    expect(config.creditsFromProvider).toBe(false);
  });

  it("bills the active provider's own price, ahead of the saved global one", async () => {
    await updateSettings({ searchCreditsPerCall: 2 });
    process.env.SEARCH_CREDITS_PER_CALL = "5";
    await createSearchProvider({
      name: "Cheap",
      kind: "searxng",
      baseUrl: "https://cheap.example",
      priority: 1,
      creditsPerCall: 7,
    });

    const config = await loadSearchConfig();
    expect(config.creditsPerCall).toBe(7);
    expect(config.creditsFromProvider).toBe(true);
  });

  it("uses the price of the provider that actually serves", async () => {
    const chosen = await createSearchProvider({
      name: "Second",
      kind: "searxng",
      baseUrl: "https://second.example",
      priority: 2,
      creditsPerCall: 3,
    });
    // The priority-1 row is disabled, so the second one answers — and its price
    // is the one that must apply.
    const off = await createSearchProvider({
      name: "First",
      kind: "searxng",
      baseUrl: "https://first.example",
      priority: 1,
      creditsPerCall: 9,
    });
    await updateSearchProvider(off.id, { enabled: false });

    const config = await loadSearchConfig();
    expect(config.backendProviderId).toBe(chosen.id);
    expect(config.creditsPerCall).toBe(3);
  });

  it("is unconfigured when every provider is disabled, even with the environment set", async () => {
    process.env.SEARXNG_URL = "https://env.example";
    const row = await createSearchProvider({ name: "Only", kind: "searxng", baseUrl: "https://db.example" });
    await updateSearchProvider(row.id, { enabled: false });

    const config = await loadSearchConfig();
    // Falling back here would make the disable button a decoration.
    expect(config.backendConfigured).toBe(false);
    expect(config.backendSource).toBeNull();
    expect(config.backendProviderId).toBeNull();
  });

  it("does not expose a backend URL for a keyed provider", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    try {
      const config = await loadSearchConfig();
      expect(config.backendConfigured).toBe(true);
      expect(config.backendName).toBe("Tavily");
      // The internal address belongs to SearXNG; there is none here.
      expect(config.backendUrl).toBeNull();
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });
});

describe("environment price parsing", () => {
  const env = (value: string): NodeJS.ProcessEnv =>
    ({ SEARCH_CREDITS_PER_CALL: value }) as unknown as NodeJS.ProcessEnv;

  it("accepts non-negative integers and rejects everything else", () => {
    expect(envSearchCredits(env("0"))).toBe(0);
    expect(envSearchCredits(env("12"))).toBe(12);
    for (const bad of ["", "  ", "-1", "1.5", "abc"]) {
      expect(envSearchCredits(env(bad)), bad).toBeUndefined();
    }
  });
});
