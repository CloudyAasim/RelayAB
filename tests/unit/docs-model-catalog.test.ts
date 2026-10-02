/**
 * tests/unit/docs-model-catalog.test.ts
 *
 * The catalogue, which answers "which model should I use".
 *
 * Three complaints, three things that were true of the old page:
 *
 *  - chat and media models shared one table, so half of every row was a dash —
 *    a media row has no context window to print, and a chat row had nowhere
 *    to put the capability that tells two image models apart;
 *  - the provider column was a name, and the same name appears in both lists
 *    (`MiniMax` serves the chat models *and* the media ones), so it told a
 *    reader nothing about which base URL or which endpoint they were looking at;
 *  - the spec's own `metadata` — which sizes a model accepts, which modes, how
 *    many reference images — was being loaded on every request and rendered
 *    nowhere.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildModelCatalog } from "@/lib/docs/catalog";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { createMediaProvider } from "@/lib/db/media-providers";
import { MINIMAX_IMAGE_SPEC, MINIMAX_TTS_SPEC } from "@/lib/media/seeds";
import { updateSettings } from "@/lib/db/settings";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

let currentStore: InMemoryCookieStore | null = null;

vi.mock("next/headers", () => ({ cookies: async () => currentStore }));

const CATALOG = readFileSync(join(process.cwd(), "src", "components", "docs", "ModelCatalog.tsx"), "utf-8");

describe("the catalogue separates the two kinds", () => {
  beforeEach(async () => {
    __resetDbForTest();
    currentStore = new InMemoryCookieStore();
    const user = (await createUser({
      username: "catalog",
      password: "correct horse battery",
      displayName: "catalog",
    }))!;
    const session = await getSessionFromStore(currentStore);
    session.userId = user.id;
    session.username = user.username;
    session.role = user.role;
    await session.save();

    // One name, two very different things — which is the whole point.
    await createProvider({
      name: "Shared Vendor",
      kind: "openai",
      baseUrl: "https://api.vendor.example/v1",
      apiKey: "vendor-key",
      modelMapping: { "chat-big": "vendor-chat-big" },
      modelConfigs: {
        "chat-big": {
          upstreamId: "vendor-chat-big",
          clientId: "chat-big",
          contextLength: 200_000,
          maxOutputTokens: 16_000,
        },
      },
      priority: 3,
    });
    await createMediaProvider({
      name: "Shared Vendor",
      baseUrl: "https://api.vendor.example",
      apiKey: "vendor-key",
      priority: 7,
      models: {
        "image-01": { upstreamId: "image-01", pricePerItem: 250, enabled: true },
      },
      specs: [MINIMAX_IMAGE_SPEC as unknown as Record<string, unknown>],
    });
  });

  it("marks each model with which kind it is", async () => {
    const catalog = await buildModelCatalog();
    const chat = catalog.models.find((m) => m.id === "chat-big");
    const media = catalog.models.find((m) => m.id === "image-01");
    expect(chat?.kind).toBe("chat");
    expect(media?.kind).toBe("media");
    expect(catalog.chatCount).toBe(1);
    expect(catalog.mediaCount).toBe(1);
  });

  it("gives each model the provider that serves it, not just a name", async () => {
    const catalog = await buildModelCatalog();
    const media = catalog.models.find((m) => m.id === "image-01")!;
    // The same string as the chat provider's, and now with something under it.
    expect(media.source.name).toBe("Shared Vendor");
    expect(media.source.kind).toBe("media");
    expect(media.source.baseUrl).toBe("https://api.vendor.example");
    expect(media.source.priority).toBe(7);
    expect(media.source.endpoint).toBe("/v1/image_generation");
  });

  it("records the upstream name, which is rarely the client id", async () => {
    const catalog = await buildModelCatalog();
    expect(catalog.models.find((m) => m.id === "chat-big")?.upstreamId).toBe("vendor-chat-big");
  });

  it("carries the spec's metadata through to the reader", async () => {
    const catalog = await buildModelCatalog();
    const media = catalog.models.find((m) => m.id === "image-01")!;
    // This was being read from the database on every request and printed
    // nowhere, which is the whole "which sizes does it take" question.
    expect(media.meta).toBeTruthy();
    expect(Array.isArray(media.meta.modes)).toBe(true);
    expect((media.meta.modes as string[])).toContain("image-to-image");
  });

  it("lists providers with a kind, so the same name can appear twice", async () => {
    const catalog = await buildModelCatalog();
    const shared = catalog.providers.filter((p) => p.name === "Shared Vendor");
    expect(shared).toHaveLength(2);
    expect(shared.map((p) => p.kind).sort()).toEqual(["chat", "media"]);
    // And with the address, because the name alone is the thing being useless.
    expect(shared.every((p) => p.baseUrl)).toBe(true);
  });

  it("hides a model the operator turned off, and the rest survive", async () => {
    await updateSettings({ modelNotes: { "image-01": { hidden: true } } });
    const catalog = await buildModelCatalog();
    expect(catalog.models.find((m) => m.id === "image-01")).toBeUndefined();
    expect(catalog.models.find((m) => m.id === "chat-big")).toBeDefined();
  });
});

describe("the page renders what the catalogue now carries", () => {
  it("two tables, one per kind", () => {
    // The columns are not the same for the two kinds, and pretending they are
    // is what made the old single table half dashes.
    expect(CATALOG).toMatch(/\["chat", "media"\] as const\)\.map/);
    expect(CATALOG).toContain("docs.catalog.groupChat");
    expect(CATALOG).toContain("docs.catalog.groupMedia");
  });

  it("a media row gets a capability and an endpoint, not a context window", () => {
    expect(CATALOG).toMatch(/t\("docs\.catalog\.endpoint"\)/);
    expect(CATALOG).toMatch(/t\("docs\.catalog\.kind"\)/);
  });

  it("the provider column shows more than the name", () => {
    // The old column was `{m.provider}` — a string that says the same thing
    // for the chat provider and the media one. Scoped to the cell, and
    // asserted on the *conditional* form: the base url appears twice in that
    // cell (the test and the body), so looking for the bare name passes on a
    // page that stopped showing it.
    const cell = CATALOG.slice(
      CATALOG.indexOf('<td className="py-2 pr-3 text-xs">'),
      CATALOG.indexOf('{isChat ? (', CATALOG.indexOf('<td className="py-2 pr-3 text-xs">')),
    );
    expect(cell, "the provider cell is not where it was").toContain("m.source.name");
    expect(cell).toContain("{m.source.baseUrl && (");
    expect(cell).toContain("m.source.priority !== null && (");
  });

  it("and the detail row renders the metadata that was being loaded and dropped", () => {
    expect(CATALOG).toMatch(/meta\.modes/);
    expect(CATALOG).toMatch(/meta\.sizes/);
    expect(CATALOG).toMatch(/max_reference_images/);
    // Whatever the spec carries beyond the three known keys is shown too,
    // rather than silently dropped like it was.
    expect(CATALOG).toMatch(/Object\.entries\(meta\)\.filter/);
  });

  it("the provider list is split the same way", () => {
    expect(CATALOG).toMatch(/providers\.filter\(\(p\) => p\.kind !== "media"\)/);
    expect(CATALOG).toMatch(/providers\.filter\(\(p\) => p\.kind === "media"\)/);
  });
});

void MINIMAX_TTS_SPEC;
