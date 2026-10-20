/**
 * tests/unit/search-switch-migration.test.ts
 *
 * The feature-wide search switch became the provider rows.
 *
 * There used to be a switch beside the provider list that turned web search
 * off for the whole deployment, and a second source of truth for a fact the
 * rows already carry. It is gone — the rows are the switch now — but a
 * deployment that had deliberately switched search off must not wake up with
 * search on.
 *
 * So the switch's "off" was **folded into the rows it governed**: every
 * provider row is disabled, which is what "off" meant to that deployment, and
 * what the operator sees afterwards. This test is the one that proves the
 * folding happened, because the failure it guards against is silent: the
 * feature would simply start answering again.
 *
 * It runs against a **file** database on purpose. The migration runs when the
 * database is opened, and the in-memory database every other test uses is
 * thrown away on close — so the only way to see a migration happen is to close
 * a database that has the old state and open it again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPath = process.env.RELAY_DB_PATH;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-migration-"));
  process.env.RELAY_DB_PATH = join(dir, "relay.db");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.RELAY_DB_PATH;
  else process.env.RELAY_DB_PATH = originalPath;
  // Close the database before removing it: on Windows an open file cannot be
  // deleted, and the handle is held by the module until it is reset.
  const { __resetDbForTest } = await import("@/lib/db/sqlite");
  __resetDbForTest();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Open the database (creating it on the first call) and hand back the handle. */
async function open(): Promise<void> {
  const { __resetDbForTest } = await import("@/lib/db/sqlite");
  __resetDbForTest();
  // Any statement opens it; the migration has already run by then.
  const { getOne } = await import("@/lib/db/sqlite");
  getOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master");
}

describe("folding the old feature-wide switch into the provider rows", () => {
  it("disables every row when the switch was off", async () => {
    await open();
    const { run, getOne } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('searchEnabled', 'false')");
    run(
      `INSERT INTO search_providers (id, name, kind, base_url, enabled, priority, created_at, updated_at)
       VALUES ('r1', 'Local', 'searxng', 'https://s.example', 1, 1, '2026-01-01', '2026-01-01')`,
    );
    // Pretend the database is still at the version before the migration.
    run("DELETE FROM schema_version WHERE version > 1");

    // Reopening runs the migration.
    await open();

    const row = getOne<{ enabled: number }>("SELECT enabled FROM search_providers WHERE id = 'r1'");
    expect(row?.enabled).toBe(0);
  });

  it("leaves the rows alone when the switch was not off", async () => {
    await open();
    const { run, getOne } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('searchEnabled', 'true')");
    run(
      `INSERT INTO search_providers (id, name, kind, base_url, enabled, priority, created_at, updated_at)
       VALUES ('r2', 'Local', 'searxng', 'https://s.example', 1, 1, '2026-01-01', '2026-01-01')`,
    );
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    const row = getOne<{ enabled: number }>("SELECT enabled FROM search_providers WHERE id = 'r2'");
    expect(row?.enabled).toBe(1);
  });

  it("leaves the rows alone when there was no switch at all", async () => {
    await open();
    const { run, getOne } = await import("@/lib/db/sqlite");
    run(
      `INSERT INTO search_providers (id, name, kind, base_url, enabled, priority, created_at, updated_at)
       VALUES ('r3', 'Local', 'searxng', 'https://s.example', 1, 1, '2026-01-01', '2026-01-01')`,
    );
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    const row = getOne<{ enabled: number }>("SELECT enabled FROM search_providers WHERE id = 'r3'");
    expect(row?.enabled).toBe(1);
  });

  it("runs once: a second open does not touch the rows again", async () => {
    await open();
    const { run, getOne } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('searchEnabled', 'false')");
    run(
      `INSERT INTO search_providers (id, name, kind, base_url, enabled, priority, created_at, updated_at)
       VALUES ('r4', 'Local', 'searxng', 'https://s.example', 1, 1, '2026-01-01', '2026-01-01')`,
    );
    run("DELETE FROM schema_version WHERE version > 1");

    await open();
    // The operator re-enables the row — the new way of switching search on.
    run("UPDATE search_providers SET enabled = 1 WHERE id = 'r4'");

    await open();

    const row = getOne<{ enabled: number }>("SELECT enabled FROM search_providers WHERE id = 'r4'");
    expect(row?.enabled).toBe(1);
  });
});
