/**
 * tests/integration/announcements-repo.test.ts
 *
 * The announcement repository: rows, windows, and the two lists that differ.
 *
 * Two lists that read the same table and must never answer the same question:
 *
 *  - `listActiveAnnouncements` → what a banner may show **now**;
 *  - `listPublishedAnnouncements` → the announcement centre's history, which
 *    keeps what has finished and hides what was never published or was
 *    withdrawn.
 *
 * The window is the whole point of the table, and every boundary is half-open
 * (`[startsAt, endsAt)`), so a row whose `endsAt` is exactly `now` is over. That
 * is what makes "ends at 20:00" mean the notice is gone at 20:00 and not one
 * millisecond later.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest, run } from "@/lib/db/sqlite";
import {
  AnnouncementValidationError,
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncementById,
  listActiveAnnouncements,
  listAnnouncements,
  listPublishedAnnouncements,
  getPublishedAnnouncement,
  toPublicAnnouncement,
  updateAnnouncement,
  type AnnouncementRecord,
} from "@/lib/db/announcements";
import { announcementState } from "@/lib/announcements/types";

beforeEach(() => {
  __resetDbForTest();
});

/**
 * A row at a known window, for the boundary tests.
 *
 * `created_at` is rewritten afterwards because the repository stamps "now" and
 * the ordering is by that column: two rows created in the same millisecond tie
 * there and fall through to `id DESC`, which is random. A test that asserts an
 * order has to pin the timestamps it is ordering by, or it passes or fails on
 * how fast the machine happened to be.
 */
async function at(over: {
  createdAt: string;
  startsAt?: string | null;
  endsAt?: string | null;
  enabled?: boolean;
  pinned?: boolean;
  title?: string;
}): Promise<AnnouncementRecord> {
  const row = await createAnnouncement({
    title: over.title ?? "Notice",
    body: "Body",
    enabled: over.enabled ?? true,
    pinned: over.pinned ?? false,
    startsAt: over.startsAt ?? null,
    endsAt: over.endsAt ?? null,
  });
  run("UPDATE announcements SET created_at = ? WHERE id = ?", [over.createdAt, row.id]);
  return { ...row, createdAt: over.createdAt };
}

describe("create", () => {
  it("stores a plain announcement, live from now", async () => {
    const row = await createAnnouncement({ title: "  Maintenance  ", body: "  At 20:00  " });
    expect(row.title).toBe("Maintenance");
    expect(row.body).toBe("At 20:00");
    expect(row.level).toBe("info");
    expect(row.pinned).toBe(false);
    expect(row.enabled).toBe(true);
    expect(row.startsAt).toBeNull();
    expect(row.endsAt).toBeNull();
  });

  it("keeps the level it was given, and every one of the four is accepted", async () => {
    for (const level of ["info", "success", "warning", "danger"] as const) {
      const row = await createAnnouncement({ title: "T", body: "B", level });
      expect(row.level).toBe(level);
    }
  });

  it("normalises both window bounds to ISO instants", async () => {
    const row = await createAnnouncement({
      title: "T",
      body: "B",
      startsAt: "2026-01-01T00:00",
      endsAt: "2026-01-02T00:00:00Z",
    });
    expect(row.startsAt).toBe(new Date("2026-01-01T00:00").toISOString());
    expect(row.endsAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("refuses an empty title or body", async () => {
    await expect(createAnnouncement({ title: "   ", body: "B" })).rejects.toThrow(
      AnnouncementValidationError,
    );
    await expect(createAnnouncement({ title: "T", body: "" })).rejects.toThrow(
      AnnouncementValidationError,
    );
  });

  it("refuses a level outside the four", async () => {
    // A cast, because the type already says no: the guard is for the route,
    // which receives JSON.
    await expect(
      createAnnouncement({ title: "T", body: "B", level: "critical" as never }),
    ).rejects.toThrow(/Level must be one of/);
  });

  it("refuses a window that ends before it starts", async () => {
    // Not an empty window: it would save, look complete in the list, and never
    // be shown to anybody.
    await expect(
      createAnnouncement({
        title: "T",
        body: "B",
        startsAt: "2026-01-02T00:00",
        endsAt: "2026-01-01T00:00",
      }),
    ).rejects.toThrow(/end time must be after the start time/);
  });

  it("refuses a bound that is not a date", async () => {
    await expect(
      createAnnouncement({ title: "T", body: "B", endsAt: "next tuesday" }),
    ).rejects.toThrow(/not a valid date and time/);
  });

  it("treats an empty string as no bound at all", async () => {
    // `<input type="datetime-local">` submits "" when cleared, and that is the
    // form saying "no bound", not a malformed instant.
    const row = await createAnnouncement({ title: "T", body: "B", startsAt: "", endsAt: "" });
    expect(row.startsAt).toBeNull();
    expect(row.endsAt).toBeNull();
  });
});

describe("update", () => {
  it("merges: the switch does not need the title resent", async () => {
    const row = await createAnnouncement({ title: "T", body: "B" });
    const off = await updateAnnouncement(row.id, { enabled: false });
    expect(off?.enabled).toBe(false);
    expect(off?.title).toBe("T");
    expect(off?.body).toBe("B");
  });

  it("validates the whole row, not only the patched fields", async () => {
    // The inverted window the create path refuses must not be reachable by
    // moving one end of it.
    const row = await createAnnouncement({
      title: "T",
      body: "B",
      startsAt: "2026-01-01T00:00",
    });
    await expect(
      updateAnnouncement(row.id, { endsAt: "2025-12-31T00:00" }),
    ).rejects.toThrow(/end time must be after the start time/);
  });

  it("clears a bound when the patch says null", async () => {
    const row = await createAnnouncement({
      title: "T",
      body: "B",
      startsAt: "2026-01-01T00:00",
      endsAt: "2026-02-01T00:00",
    });
    const cleared = await updateAnnouncement(row.id, { endsAt: null });
    expect(cleared?.endsAt).toBeNull();
    // …and says nothing about the end it did not mention.
    expect(cleared?.startsAt).toBe(row.startsAt);
  });

  it("returns null for a row that is not there", async () => {
    expect(await updateAnnouncement("nope", { title: "T" })).toBeNull();
  });
});

describe("delete", () => {
  it("removes the row and reports whether there was one", async () => {
    const row = await createAnnouncement({ title: "T", body: "B" });
    expect(await deleteAnnouncement(row.id)).toBe(true);
    expect(await getAnnouncementById(row.id)).toBeNull();
    expect(await deleteAnnouncement(row.id)).toBe(false);
  });
});

describe("listAnnouncements", () => {
  it("shows every state, pinned first and newest next", async () => {
    // Distinct timestamps: an assertion about order cannot ride on the clock.
    const old = await at({ title: "old", createdAt: "2026-01-01T00:00:01.000Z" });
    const off = await at({ title: "off", createdAt: "2026-01-01T00:00:02.000Z", enabled: false });
    const pinned = await at({ title: "pinned", createdAt: "2026-01-01T00:00:03.000Z", pinned: true });
    const doomed = await at({
      title: "future",
      createdAt: "2026-01-01T00:00:04.000Z",
      startsAt: "2099-01-01T00:00",
    });

    const rows = await listAnnouncements();
    // Pinned first regardless of its date; the rest newest first.
    expect(rows.map((r) => r.title)).toEqual(["pinned", "future", "off", "old"]);
    // Every id made it: nothing is filtered here.
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set([old.id, off.id, pinned.id, doomed.id]),
    );
  });
});

describe("the active window", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const before = "2026-06-15T11:00:00.000Z";
  const after = "2026-06-15T13:00:00.000Z";

  it("keeps a row with no bounds at all", async () => {
    await at({ createdAt: before });
    expect(await listActiveAnnouncements(now)).toHaveLength(1);
  });

  it("keeps a row that has begun and not ended", async () => {
    await at({ createdAt: before, startsAt: before, endsAt: after });
    expect(await listActiveAnnouncements(now)).toHaveLength(1);
  });

  it("drops a row that has not begun", async () => {
    await at({ createdAt: before, startsAt: after });
    expect(await listActiveAnnouncements(now)).toHaveLength(0);
  });

  it("drops a row whose window closes exactly now, because the window is half-open", async () => {
    await at({ createdAt: before, endsAt: now.toISOString() });
    expect(await listActiveAnnouncements(now)).toHaveLength(0);
  });

  it("keeps a row that starts exactly now", async () => {
    await at({ createdAt: before, startsAt: now.toISOString() });
    expect(await listActiveAnnouncements(now)).toHaveLength(1);
  });

  it("drops a switched-off row whose window is open", async () => {
    await at({ createdAt: before, enabled: false });
    expect(await listActiveAnnouncements(now)).toHaveLength(0);
  });

  it("orders pinned first, then newest", async () => {
    await createAnnouncement({ title: "new", body: "B", startsAt: "2020-01-01T00:00" });
    await createAnnouncement({ title: "pinned", body: "B", pinned: true });
    await createAnnouncement({ title: "another", body: "B" });
    const titles = (await listActiveAnnouncements(now)).map((r) => r.title);
    expect(titles[0]).toBe("pinned");
  });
});

describe("the published history", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("keeps a finished row, and puts it after the live ones", async () => {
    await createAnnouncement({
      title: "live",
      body: "B",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-07-01T00:00:00.000Z",
    });
    await createAnnouncement({
      title: "over",
      body: "B",
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
    });

    const rows = await listPublishedAnnouncements(now);
    expect(rows.map((r) => r.title)).toEqual(["live", "over"]);
  });

  it("hides a draft and a withdrawal, but not a finished notice", async () => {
    // Not started → a draft; switched off → withdrawn. Neither belongs in a
    // reader's history, and both would be indistinguishable from one that is
    // simply ordinary if the list did not filter by state.
    await createAnnouncement({ title: "draft", body: "B", startsAt: "2099-01-01T00:00" });
    await createAnnouncement({ title: "withdrawn", body: "B", enabled: false });
    await createAnnouncement({ title: "ordinary", body: "B" });

    const titles = (await listPublishedAnnouncements(now)).map((r) => r.title);
    expect(titles).toEqual(["ordinary"]);
  });

  it("keeps a pinned row above the live ones", async () => {
    await createAnnouncement({ title: "live", body: "B" });
    await createAnnouncement({ title: "pinned", body: "B", pinned: true });
    expect((await listPublishedAnnouncements(now))[0].title).toBe("pinned");
  });
});

describe("one published row by id", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("finds a live row and a finished one alike", async () => {
    const live = await createAnnouncement({ title: "live", body: "B" });
    const over = await createAnnouncement({
      title: "over",
      body: "B",
      startsAt: "2026-05-01T00:00:00.000Z",
      endsAt: "2026-06-01T00:00:00.000Z",
    });

    // A finished notice stays readable: the detail page is where "what did that
    // maintenance window actually say?" gets answered after it closed.
    expect((await getPublishedAnnouncement(live.id, now))?.title).toBe("live");
    expect((await getPublishedAnnouncement(over.id, now))?.title).toBe("over");
  });

  it("refuses a draft and a withdrawal, so a guessed id opens nothing", async () => {
    // The same two rules as the list: a row that appears in the centre always
    // opens, and one that does not, never does.
    const draft = await createAnnouncement({
      title: "draft",
      body: "B",
      startsAt: "2099-01-01T00:00:00.000Z",
    });
    const withdrawn = await createAnnouncement({ title: "withdrawn", body: "B", enabled: false });

    expect(await getPublishedAnnouncement(draft.id, now)).toBeNull();
    expect(await getPublishedAnnouncement(withdrawn.id, now)).toBeNull();
  });

  it("returns null for an id that never existed", async () => {
    expect(await getPublishedAnnouncement("no-such-id", now)).toBeNull();
  });

  it("still finds a draft once it starts, without being told to", async () => {
    const draft = await createAnnouncement({
      title: "later",
      body: "B",
      startsAt: "2026-07-01T00:00:00.000Z",
    });
    expect(await getPublishedAnnouncement(draft.id, now)).toBeNull();
    expect((await getPublishedAnnouncement(draft.id, new Date("2026-07-02T00:00:00.000Z")))?.title).toBe(
      "later",
    );
  });
});

describe("what a reader receives", () => {
  it("has no enabled switch on it", async () => {
    const row = await createAnnouncement({ title: "T", body: "B" });
    const pub = toPublicAnnouncement(row);
    expect(pub).not.toHaveProperty("enabled");
    expect(pub).not.toHaveProperty("updatedAt");
    // The window and the pin stay: a surface has to be able to say when the
    // message stops applying, and the pin is what the reader's order means.
    expect(pub.startsAt).toBeNull();
    expect(pub.pinned).toBe(false);
  });

  it("reports the same level the row carries", async () => {
    const row = await createAnnouncement({ title: "T", body: "B", level: "danger" });
    expect(toPublicAnnouncement(row).level).toBe("danger");
  });
});

describe("the derived state", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("names the four mutually exclusive cases", async () => {
    const base = { enabled: true, startsAt: null, endsAt: null };
    expect(announcementState(base, now)).toBe("live");
    expect(announcementState({ ...base, enabled: false }, now)).toBe("off");
    expect(announcementState({ ...base, startsAt: "2026-07-01T00:00:00.000Z" }, now)).toBe(
      "scheduled",
    );
    expect(announcementState({ ...base, endsAt: "2026-06-01T00:00:00.000Z" }, now)).toBe(
      "expired",
    );
  });

  it("reads an unparseable bound as no bound rather than as the future", async () => {
    // "always scheduled" would hide the notice for ever, and nothing would ever
    // rewrite the value.
    expect(announcementState({ enabled: true, startsAt: "whenever", endsAt: null }, now)).toBe(
      "live",
    );
  });

  it("reports a switched-off row as off even when its window has finished", async () => {
    // Both are true; `off` is the one the operator did.
    expect(
      announcementState(
        { enabled: false, startsAt: null, endsAt: "2026-06-01T00:00:00.000Z" },
        now,
      ),
    ).toBe("off");
  });
});