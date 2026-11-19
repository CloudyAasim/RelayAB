/**
 * tests/integration/announcement-migration.test.ts
 *
 * The docs announcement string became the first announcement row.
 *
 * `settings.announcement` was one string the public docs page printed, and it
 * could not be scheduled, could not expire, could not be taken down without
 * erasing the text, and logged-in users never saw it. Rows replace it — which
 * means the text an operator had already written has to move, or a redeploy
 * silently quiets the docs page while the text sits in a key nothing reads.
 *
 * It runs against a **file** database on purpose: the migration runs when the
 * database is opened, so the only way to watch it happen is to close a database
 * that holds the old state and open it again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalPath = process.env.RELAY_DB_PATH;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-announcement-migration-"));
  process.env.RELAY_DB_PATH = join(dir, "relay.db");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.RELAY_DB_PATH;
  else process.env.RELAY_DB_PATH = originalPath;
  // Close before removing: on Windows an open file cannot be deleted.
  const { __resetDbForTest } = await import("@/lib/db/sqlite");
  __resetDbForTest();
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function open(): Promise<void> {
  const { __resetDbForTest } = await import("@/lib/db/sqlite");
  __resetDbForTest();
  const { getOne } = await import("@/lib/db/sqlite");
  getOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master");
}

describe("the old docs announcement becomes a row", () => {
  it("moves the text, with its first line as the title", async () => {
    await open();
    const { run } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('announcement', ?)", [
      "Scheduled maintenance\n\nThe gateway restarts at 20:00.",
    ]);
    // Pretend the database is still at the version before the migration.
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    const { getAll } = await import("@/lib/db/sqlite");
    const rows = getAll<{ title: string; body: string; level: string; enabled: number }>(
      "SELECT title, body, level, enabled FROM announcements",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Scheduled maintenance");
    // The whole text, first line included: it may have been the sentence that
    // mattered, and a migration is not the place to decide that.
    expect(rows[0].body).toBe("Scheduled maintenance\n\nThe gateway restarts at 20:00.");
    // The old field had no level and no window, which is exactly `info` and
    // "live from now until somebody removes it".
    expect(rows[0].level).toBe("info");
    expect(rows[0].enabled).toBe(1);
  });

  it("deletes the settings key, so there is one source of truth", async () => {
    await open();
    const { run, getOne } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('announcement', 'Notice')");
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    expect(
      getOne<{ value: string }>("SELECT value FROM settings WHERE key = 'announcement'"),
    ).toBeFalsy();
  });

  it("does nothing when there was no announcement", async () => {
    await open();
    const { run, getAll } = await import("@/lib/db/sqlite");
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    expect(getAll("SELECT id FROM announcements")).toEqual([]);
  });

  it("does nothing when the announcement was blank", async () => {
    // An empty string in `settings` is not a notice. It is also the shape
    // `updateSettings` used to write when a field was cleared.
    await open();
    const { run, getAll } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('announcement', '   \n  ')");
    run("DELETE FROM schema_version WHERE version > 1");

    await open();

    expect(getAll("SELECT id FROM announcements")).toEqual([]);
  });

  it("runs once: a second open does not duplicate the row", async () => {
    await open();
    const { run, getAll } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('announcement', 'Notice')");
    run("DELETE FROM schema_version WHERE version > 1");

    await open();
    await open();

    expect(getAll("SELECT id FROM announcements")).toHaveLength(1);
  });

  it("does not touch a row an operator has since edited", async () => {
    // The delete of the settings key is what makes this idempotent: without it,
    // a second run would import the stale text again and overwrite nothing but
    // add a duplicate.
    await open();
    const { run, getAll } = await import("@/lib/db/sqlite");
    run("INSERT INTO settings (key, value) VALUES ('announcement', 'First')");
    run("DELETE FROM schema_version WHERE version > 1");
    await open();
    run("UPDATE announcements SET title = 'Edited by hand'");

    await open();

    const rows = getAll<{ title: string }>("SELECT title FROM announcements");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Edited by hand");
  });
});