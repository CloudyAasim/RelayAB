/**
 * tests/unit/provider-routing-normalisation.test.ts
 *
 * One answer to "how does each surface reach this provider".
 *
 * ## The hole this closes
 *
 * The route table became the answer about routing, and the columns that came
 * before it were still being written by hand. That is **two answers to one
 * question**, and they were not connected:
 *
 *  - a table that said "nothing is served" was stored as an empty array, and
 *    an empty array read as "this row predates the table" — so a provider whose
 *    every surface had been switched off came back switched **on**;
 *  - a writer that only knew the old vocabulary (the assistant does) changed
 *    those columns, and the table outvoted them: the change was saved, the
 *    diff said it was applied, and nothing happened;
 *  - the same for the mode: changing which dialects a vendor speaks in
 *    advanced mode did not change how any surface reached it.
 *
 * So the routing is now resolved in **one place**, and the table is what gets
 * written. The columns are derived from it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetDbForTest, getOne, run } from "@/lib/db/sqlite";
import { createProvider, getProviderById, updateProvider } from "@/lib/db/providers";
import {
  emptyRoutes,
  routesOf,
  serializeRoutes,
  type SurfaceRoutes,
} from "@/lib/protocol/surface-routes";

/** A table in which every surface is switched off. */
const ALL_OFF: SurfaceRoutes = {
  "openai-chat": { kind: "unsupported" },
  "openai-responses": { kind: "unsupported" },
  "anthropic-messages": { kind: "unsupported" },
  "gemini-generate": { kind: "unsupported" },
};

describe("the stored table", () => {
  it("writes all four surfaces, including the ones that are not served", () => {
    // The bug: "not served" was the absence of an entry, and the absence of an
    // entry was the absence of a table.
    const stored = serializeRoutes(ALL_OFF);
    expect(stored).toHaveLength(4);
    expect(stored.every((raw) => raw.includes('"unsupported"'))).toBe(true);
  });

  it("round-trips a table that says nothing is served", () => {
    const back = routesOf({ surfaceRoutes: serializeRoutes(ALL_OFF) });
    for (const surface of Object.keys(ALL_OFF) as Array<keyof SurfaceRoutes>) {
      expect(back[surface]).toEqual({ kind: "unsupported" });
    }
  });

  it("and a row that says nothing is served stays that way", async () => {
    // The regression, end to end: the row is written, read back from the
    // database, and still off.
    const created = await createProvider({
      name: "Off",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    await updateProvider(created.id, { surfaceRoutes: serializeRoutes(ALL_OFF) });

    const stored = await getProviderById(created.id);
    expect(stored).toBeTruthy();
    const routes = routesOf(stored!);
    expect(routes["openai-chat"].kind).toBe("unsupported");
    expect(routes["openai-responses"].kind).toBe("unsupported");
    expect(routes["anthropic-messages"].kind).toBe("unsupported");
    expect(routes["gemini-generate"].kind).toBe("unsupported");
  });
});

describe("the write boundary", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("derives the columns from the table", async () => {
    const created = await createProvider({
      name: "V",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    // A Responses vendor: the Chat surface is a passthrough (it speaks Chat),
    // the Responses surface is native.
    const updated = await updateProvider(created.id, {
      surfaceRoutes: serializeRoutes({
        "openai-chat": { kind: "passthrough" },
        "openai-responses": { kind: "passthrough" },
        "anthropic-messages": { kind: "unsupported" },
        "gemini-generate": { kind: "unsupported" },
      }),
    });
    // The column names the vendor's own protocol — which is the Responses
    // surface's dialect, not the Chat surface's.
    expect(updated!.upstreamFormat).toBe("responses");
    expect(updated!.openaiEnabled).toBe(true);
    expect(updated!.anthropicEnabled).toBe(false);
  });

  it("lets a writer that speaks the old vocabulary change the routing", async () => {
    // This is what the assistant's tools do, and what used to be saved and
    // then ignored: the row had a table, the table outvoted the change.
    const created = await createProvider({
      name: "V",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    const updated = await updateProvider(created.id, {
      anthropicEnabled: true,
      anthropicMode: "native",
    });
    expect(routesOf(updated!)["anthropic-messages"]).toEqual({ kind: "passthrough" });
    expect(updated!.anthropicEnabled).toBe(true);
  });

  it("keeps the table when the patch says nothing about the routing", async () => {
    const created = await createProvider({
      name: "V",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    const withTable = await updateProvider(created.id, {
      surfaceRoutes: serializeRoutes({
        "openai-chat": { kind: "passthrough" },
        "openai-responses": { kind: "route", dialect: "chat" },
        "anthropic-messages": { kind: "unsupported" },
        "gemini-generate": { kind: "unsupported" },
      }),
    });
    const renamed = await updateProvider(created.id, { name: "Renamed" });
    expect(renamed!.name).toBe("Renamed");
    expect(routesOf(renamed!)).toEqual(routesOf(withTable!));
  });

  it("lets the mode decide, and the dialects with it", async () => {
    // Advanced mode: which dialects the vendor speaks decides how each surface
    // reaches it. Before this, changing the dialects changed nothing at all.
    const created = await createProvider({
      name: "V",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    const updated = await updateProvider(created.id, {
      protocolMode: "advanced",
      upstreamDialects: ["gemini"],
    });
    // The vendor speaks Gemini, so the Gemini surface is its own — reached the
    // way the client asked — and the other surfaces are translated into it.
    expect(routesOf(updated!)["gemini-generate"]).toEqual({ kind: "passthrough" });
    expect(routesOf(updated!)["openai-chat"]).toEqual({ kind: "route", dialect: "gemini" });
    expect(routesOf(updated!)["openai-responses"]).toEqual({ kind: "route", dialect: "gemini" });
  });

  it("and passthrough mode means every surface in its own vocabulary", async () => {
    const created = await createProvider({
      name: "V",
      kind: "openai",
      apiKey: "sk-x",
      modelMapping: { m: "m" },
    });
    const updated = await updateProvider(created.id, { protocolMode: "passthrough" });
    for (const surface of Object.keys(emptyRoutes()) as Array<keyof SurfaceRoutes>) {
      expect(routesOf(updated!)[surface], surface).toEqual({ kind: "passthrough" });
    }
  });
});

describe("the migration", () => {
  const originalPath = process.env.RELAY_DB_PATH;
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-routing-migration-"));
    process.env.RELAY_DB_PATH = join(dir, "relay.db");
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = originalPath;
    __resetDbForTest();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Open the database (creating it on the first call) and let the migrations run. */
  async function open(): Promise<void> {
    __resetDbForTest();
    getOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master");
  }

  /** A row written before the table existed: the columns are all there is. */
  function insertLegacyRow(id: string, format: string, anthropicOn: number): void {
    run(
      `INSERT INTO providers
         (id, name, kind, base_url, encrypted_api_key, model_mapping, model_configs,
          enabled, priority, headers, upstream_format, openai_enabled,
          anthropic_enabled, anthropic_base_url, anthropic_mode, text_specs,
          active_mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        "Legacy",
        "openai",
        "https://api.example.test/v1",
        "enc",
        "{}",
        "{}",
        1,
        1,
        "{}",
        format,
        1,
        anthropicOn,
        null,
        "native",
        "[]",
        null,
        "2026-01-01",
        "2026-01-01",
      ],
    );
  }

  it("gives every row a table, without changing how it is reached", async () => {
    await open();
    insertLegacyRow("r1", "chat", 0);

    // Pretend the database is still at the version before the migration.
    run("DELETE FROM schema_version WHERE version > 3");
    await open();

    const row = getOne<{ surface_routes: string }>(
      "SELECT surface_routes FROM providers WHERE id = 'r1'",
    );
    expect(row).toBeTruthy();
    const routes = routesOf({ surfaceRoutes: JSON.parse(row!.surface_routes) });
    // A Chat vendor: the Chat surface is native, the Responses one is reached
    // by translating into Chat — which is what the row was doing before.
    expect(routes["openai-chat"]).toEqual({ kind: "passthrough" });
    expect(routes["openai-responses"]).toEqual({ kind: "route", dialect: "chat" });
    expect(routes["anthropic-messages"]).toEqual({ kind: "unsupported" });
  });

  it("completes a table that mentions only some of the surfaces", async () => {
    await open();
    insertLegacyRow("r2", "responses", 0);
    run(
      `UPDATE providers SET surface_routes = ? WHERE id = 'r2'`,
      [JSON.stringify([{ surface: "openai-chat", kind: "passthrough" }])],
    );
    run("DELETE FROM schema_version WHERE version > 3");
    await open();

    const row = getOne<{ surface_routes: string }>(
      "SELECT surface_routes FROM providers WHERE id = 'r2'",
    );
    const stored = JSON.parse(row!.surface_routes) as string[];
    expect(stored).toHaveLength(4);
    const routes = routesOf({ surfaceRoutes: stored });
    expect(routes["openai-chat"]).toEqual({ kind: "passthrough" });
    // The surfaces the table did not mention were not served, and still are not.
    expect(routes["anthropic-messages"]).toEqual({ kind: "unsupported" });
  });
});
