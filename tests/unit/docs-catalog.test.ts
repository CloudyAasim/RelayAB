/**
 * tests/unit/docs-catalog.test.ts
 *
 * The docs catalogue is the one page a user reads to decide which model to
 * call, so its correctness matters more than any other page's. The design
 * rests on a split:
 *
 *   facts (does it exist, what is its context, what does it cost)
 *     → read live from the provider tables, on every request
 *   prose (display name, note, tags, hidden)
 *     → operator-editable, stored in settings
 *
 * The tests below pin both halves: that the facts follow the database when it
 * changes, and that no amount of operator input can make the page state a
 * context window the gateway does not have.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider, updateProvider } from "@/lib/db/providers";
import { createMediaProvider } from "@/lib/db/media-providers";
import { updateSettings } from "@/lib/db/settings";
import { buildModelCatalog } from "@/lib/docs/catalog";
import type { User } from "@/lib/db/types";

async function user(): Promise<User> {
  // The catalogue itself reads no user state, but the settings table is keyed
  // by user id only for the operator's own notes, so a real id keeps the
  // foreign key honest.
  return { id: "u-docs", username: "docs", role: "admin" } as unknown as User;
}

async function seed(): Promise<void> {
  await createProvider({
    name: "Vendor A",
    kind: "openai",
    apiKey: "sk-a",
    baseUrl: "https://a.example/v1",
    modelMapping: { big: "big", small: "small" },
    modelConfigs: {
      big: {
        upstreamId: "big",
        clientId: "big",
        contextLength: 200_000,
        maxOutputTokens: 8_000,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
      small: {
        upstreamId: "small",
        clientId: "small",
        contextLength: 32_000,
        maxOutputTokens: 4_000,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
    },
    enabled: true,
  });

  await createMediaProvider({
    name: "Vendor A Media",
    apiKey: "sk-a",
    baseUrl: "https://a.example",
    enabled: true,
    models: {
      pic: { upstreamId: "pic", pricePerItem: 2, enabled: true },
      clip: { upstreamId: "clip", pricePerItem: 0, enabled: false },
    },
    specs: [
      {
        specVersion: 1,
        capability: "image.generate",
        models: ["pic"],
        transport: { method: "POST", path: "/v1/image_generation" },
        auth: { type: "bearer" },
        response: { items: { $from: "$.data.image_urls", $to: { kind: "url", value: "$" } } },
      } as never,
    ],
  });
}

describe("model catalogue", () => {
  beforeEach(async () => {
    __resetDbForTest();
    await seed();
  });

  it("lists chat and media models with their real parameters", async () => {
    const cat = await buildModelCatalog();
    const big = cat.models.find((m) => m.id === "big");

    expect(big).toBeDefined();
    expect(big?.kind).toBe("chat");
    expect(big?.provider).toBe("Vendor A");
    expect(big?.contextLength).toBe(200_000);
    expect(big?.maxOutputTokens).toBe(8_000);
    expect(cat.chatCount).toBe(2);
    expect(cat.mediaCount).toBe(1);
  });

  it("omits a media model that is switched off", async () => {
    const cat = await buildModelCatalog();
    expect(cat.models.some((m) => m.id === "pic")).toBe(true);
    expect(cat.models.some((m) => m.id === "clip")).toBe(false);
  });

  it("follows the database when a model is added, not a stored copy", async () => {
    await createProvider({
      name: "Vendor B",
      kind: "openai",
      apiKey: "sk-b",
      baseUrl: "https://b.example/v1",
      modelMapping: { fresh: "fresh" },
      modelConfigs: {
        fresh: {
          upstreamId: "fresh",
          clientId: "fresh",
          contextLength: 1_000_000,
          maxOutputTokens: 128_000,
          inputCost: 0,
          outputCost: 0,
          enabled: true,
        },
      },
      enabled: true,
    });

    const cat = await buildModelCatalog();
    const fresh = cat.models.find((m) => m.id === "fresh");
    expect(fresh?.contextLength).toBe(1_000_000);
  });

  it("drops a model from the docs when its provider is disabled", async () => {
    const { listProviders } = await import("@/lib/db/providers");
    const [p] = await listProviders();
    await updateProvider(p.id, { enabled: false });

    const cat = await buildModelCatalog();
    expect(cat.models.some((m) => m.id === "big")).toBe(false);
  });

  it("reports an undeclared context window as null rather than guessing", async () => {
    // getModelContextLength() answers 128_000 for a model that declared
    // nothing. Printing that as a fact is the failure this page exists to
    // avoid, so the catalogue reads the raw config instead.
    await createProvider({
      name: "Vendor C",
      kind: "openai",
      apiKey: "sk-c",
      baseUrl: "https://c.example/v1",
      modelMapping: { vague: "vague" },
      enabled: true,
    });

    const cat = await buildModelCatalog();
    const vague = cat.models.find((m) => m.id === "vague");
    expect(vague).toBeDefined();
    expect(vague?.contextLength).toBeNull();
    expect(vague?.maxOutputTokens).toBeNull();
  });

  it("applies the operator's prose without touching the facts", async () => {
    await updateSettings({
      modelNotes: {
        big: { displayName: "大模型", note: "复杂推理用这个", tags: ["推理", "慢"] },
      },
    });

    const cat = await buildModelCatalog();
    const big = cat.models.find((m) => m.id === "big");
    expect(big?.displayName).toBe("大模型");
    expect(big?.note).toBe("复杂推理用这个");
    expect(big?.tags).toEqual(["推理", "慢"]);
    // The numbers still come from the provider row.
    expect(big?.contextLength).toBe(200_000);
    expect(big?.id).toBe("big");
  });

  it("a note cannot introduce a context window that does not exist", async () => {
    // The type has no such field, so even a hand-written settings row cannot
    // make the page claim a window the gateway does not have.
    await updateSettings({
      modelNotes: { big: { displayName: "x", contextLength: 99_000_000 } as never },
    });

    const cat = await buildModelCatalog();
    const big = cat.models.find((m) => m.id === "big");
    expect(big?.contextLength).toBe(200_000);
    expect(JSON.stringify(big)).not.toContain("99000000");
  });

  it("hides a model without disabling it", async () => {
    await updateSettings({ modelNotes: { small: { hidden: true } } });
    const cat = await buildModelCatalog();

    expect(cat.models.some((m) => m.id === "small")).toBe(false);
    // Still routable — the provider mapping is untouched.
    const { getProviderById } = await import("@/lib/db/providers");
    const { listProviders } = await import("@/lib/db/providers");
    const [p] = await listProviders();
    expect(Object.keys((await getProviderById(p.id))!.modelMapping)).toContain("small");
  });

  it("ignores a note for a model that no longer exists", async () => {
    await updateSettings({ modelNotes: { ghost: { note: "leftover" } } });
    const cat = await buildModelCatalog();
    expect(cat.models.some((m) => m.id === "ghost")).toBe(false);
  });

  it("falls back to sensible site defaults", async () => {
    const cat = await buildModelCatalog();
    expect(cat.site.name).toBe("RelayAB");
    expect(cat.site.description).toBe("");

    await updateSettings({ siteName: "我的中转站", siteDescription: "自建" });
    const after = await buildModelCatalog();
    expect(after.site.name).toBe("我的中转站");
    expect(after.site.description).toBe("自建");
    void (await user());
  });

  it("sorts chat before media, then by context length", async () => {
    const cat = await buildModelCatalog();
    const kinds = cat.models.map((m) => m.kind);
    const firstMedia = kinds.indexOf("media");
    expect(firstMedia).toBeGreaterThan(-1);
    expect(kinds.slice(firstMedia).every((k) => k === "media")).toBe(true);

    const chat = cat.models.filter((m) => m.kind === "chat").map((m) => m.contextLength ?? 0);
    expect(chat).toEqual([...chat].sort((a, b) => b - a));
  });
});
