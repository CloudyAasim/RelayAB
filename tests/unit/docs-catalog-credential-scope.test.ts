/**
 * tests/unit/docs-catalog-credential-scope.test.ts
 *
 * The catalogue is the list a reader treats as "what I can call". Every surface
 * that shows it to a signed-in person — the docs page, the assistant's model
 * picker and its per-model facts — now builds it with a `visible` predicate.
 *
 * The rule being pinned: a model the caller may not invoke must not appear by
 * name, and the provider rows must not count it either. A name the proxy then
 * refuses turns the list into a lie; a count that includes it says the same
 * thing in arithmetic.
 *
 * The unfiltered build stays the whole deployment on purpose: the anonymous
 * public docs and the admin settings page ask "what does this deployment serve",
 * and there the configured totals are the right answer.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider } from "@/lib/db/providers";
import { createMediaProvider } from "@/lib/db/media-providers";
import { updateSettings } from "@/lib/db/settings";
import { buildModelCatalog } from "@/lib/docs/catalog";

async function seed(): Promise<void> {
  await createProvider({
    name: "Vendor A",
    kind: "openai",
    apiKey: "sk-a",
    baseUrl: "https://a.example/v1",
    modelMapping: { big: "big", small: "small" },
    modelConfigs: {
      big: { upstreamId: "big", clientId: "big", contextLength: 200_000, maxOutputTokens: 8_000, inputCost: 0, outputCost: 0, enabled: true },
      small: { upstreamId: "small", clientId: "small", contextLength: 32_000, maxOutputTokens: 4_000, inputCost: 0, outputCost: 0, enabled: true },
    },
    enabled: true,
  });
  await createProvider({
    name: "Vendor B",
    kind: "openai",
    apiKey: "sk-b",
    baseUrl: "https://b.example/v1",
    modelMapping: { elsewhere: "elsewhere" },
    enabled: true,
  });
  await createMediaProvider({
    name: "Vendor A Media",
    apiKey: "sk-a",
    baseUrl: "https://a.example",
    mode: "spec",
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

const only = (...ids: string[]) => (id: string) => ids.includes(id);

describe("a scoped catalogue", () => {
  beforeEach(async () => {
    await __resetDbForTest();
    await seed();
  });

  it("drops the chat and media models the caller may not call", async () => {
    const cat = await buildModelCatalog({ visible: only("big", "pic") });
    expect(cat.models.map((m) => m.id).sort()).toEqual(["big", "pic"]);
    expect(cat.chatCount).toBe(1);
    expect(cat.mediaCount).toBe(1);
  });

  it("and the forbidden names are in none of the fields", async () => {
    // `providers[].models` does not exist here, but `modelCount` does — and a
    // count of 2 on a list of 1 is the leak in arithmetic form.
    const text = JSON.stringify(await buildModelCatalog({ visible: only("big", "pic") }));
    expect(text).not.toContain("small");
    expect(text).not.toContain("elsewhere");
    expect(text).not.toContain("clip");
  });

  it("counts what the provider contributed here, not what it has configured", async () => {
    const cat = await buildModelCatalog({ visible: only("big", "pic") });
    const vendorA = cat.providers.find((p) => p.name === "Vendor A" && p.kind === "chat");
    const media = cat.providers.find((p) => p.kind === "media");
    expect(vendorA?.modelCount).toBe(1);
    expect(media?.modelCount).toBe(1);
  });

  it("drops a provider left with nothing to show", async () => {
    // Its presence alone hints at a deployment the reader cannot use, and a row
    // saying "0 models" is that hint with an apology attached.
    const cat = await buildModelCatalog({ visible: only("big", "pic") });
    expect(cat.providers.map((p) => `${p.kind}:${p.name}`).sort()).toEqual([
      "chat:Vendor A",
      "media:Vendor A Media",
    ]);
  });

  it("keeps the sort and the site block the same afterwards", async () => {
    const cat = await buildModelCatalog({ visible: only("small", "pic") });
    expect(cat.models.map((m) => m.kind)).toEqual(["chat", "media"]);
    expect(cat.site.name).toBe("RelayAB");
  });
});

describe("an unscoped catalogue is unchanged", () => {
  beforeEach(async () => {
    await __resetDbForTest();
    await seed();
  });

  it("still counts every configured model, hidden ones included", async () => {
    // This is the admin settings page's number: "how many did I configure".
    // Only a filtered build redefines it, and only for that build.
    await updateSettings({ modelNotes: { small: { hidden: true } } });

    const cat = await buildModelCatalog();
    expect(cat.models.map((m) => m.id)).not.toContain("small");
    const vendorA = cat.providers.find((p) => p.name === "Vendor A" && p.kind === "chat");
    expect(vendorA?.modelCount).toBe(2);
    // And a provider with no rows in the docs is still listed on this path.
    expect(cat.providers.map((p) => p.name).sort()).toEqual(["Vendor A", "Vendor A Media", "Vendor B"]);
  });
});