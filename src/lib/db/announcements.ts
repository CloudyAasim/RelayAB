/**
 * src/lib/db/announcements.ts
 *
 * Repository for **operator announcements** — the notices a deployment needs to
 * put in front of the people using it: maintenance windows, a new model, a price
 * change, a key that leaked and must be rotated.
 *
 * Why rows instead of the single string this replaces: an announcement is not
 * site copy, it is *a message with a lifetime*. It starts mattering at some
 * point, stops mattering at another, and after that it is history — the thing
 * somebody asks about a week later ("was there a notice about this?"). One
 * string in `settings` could not do any of that: it could not be scheduled, it
 * could not expire, publishing the next notice erased the last one, and
 * logged-in users never saw it at all because only the public docs page read it.
 *
 * ## What "active" means
 *
 * For a **reader**: `enabled`, and now is inside the window. A row with no
 * `startsAt` is live from the moment it was written; a row with no `endsAt`
 * stays live until somebody takes it down. Both are deliberate — requiring a
 * window would make the common case ("say this now") two fields longer for no
 * reason, and a reader that treated a missing `endsAt` as "expired" would mute
 * every announcement written the ordinary way.
 *
 * For an **admin**: every row, whatever its state. The list has to show the
 * scheduled and the finished ones, or an announcement that has not started yet
 * looks like one that was never saved.
 */
import { generateId } from "../crypto/hashing";
import { getAll, getOne, run, toDbBool, fromDbBool } from "./sqlite";
import {
  ANNOUNCEMENT_LEVELS,
  isAnnouncementLevel,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  type AnnouncementLevel,
  type PublicAnnouncement,
} from "../announcements/types";

export {
  ANNOUNCEMENT_LEVELS,
  announcementState,
  isAnnouncementLevel,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
} from "../announcements/types";
export type { AnnouncementLevel, AnnouncementState, PublicAnnouncement } from "../announcements/types";

/** A row as stored, including the fields only an admin sees. */
export interface AnnouncementRecord {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  /** Sorts above every unpinned announcement, whatever their dates. */
  pinned: boolean;
  /** The admin's on/off switch, independent of the window. */
  enabled: boolean;
  /** ISO instant, or null for "live since it was written". */
  startsAt: string | null;
  /** ISO instant, or null for "live until taken down". */
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The shape a reader receives.
 *
 * Re-exported above from `lib/announcements/types` so the client bundle never
 * has to reach this module for a type — see that file for why the split exists.
 */

export class AnnouncementValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "AnnouncementValidationError";
    this.issues = issues;
  }
}

export interface CreateAnnouncementInput {
  title: string;
  body: string;
  level?: AnnouncementLevel;
  pinned?: boolean;
  enabled?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

export type UpdateAnnouncementInput = Partial<CreateAnnouncementInput>;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowToAnnouncement(row: Row): AnnouncementRecord {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    // A row whose level is not one of the four (a hand-edited database) reads as
    // `info` rather than crashing the page: the colour is not worth an outage.
    level: isAnnouncementLevel(row.level) ? row.level : "info",
    pinned: fromDbBool(row.pinned),
    enabled: fromDbBool(row.enabled),
    startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** Strip a record down to what a reader is allowed to see. */
export function toPublicAnnouncement(record: AnnouncementRecord): PublicAnnouncement {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    level: record.level,
    pinned: record.pinned,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Read a timestamp the form sent.
 *
 * An empty string is not an instant, it is "no window on this side", and the
 * form has to be able to say that — `<input type="datetime-local">` submits ""
 * when it is cleared. So "" and null both mean absent, and anything else has to
 * parse.
 */
function normalizeInstant(value: string | null | undefined, label: string, issues: string[]): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    issues.push(`${label}: not a valid date and time`);
    return null;
  }
  return new Date(ms).toISOString();
}

function validate(merged: {
  title: string;
  body: string;
  level: string;
  startsAt: string | null;
  endsAt: string | null;
}): string[] {
  const issues: string[] = [];

  const title = merged.title.trim();
  if (!title) issues.push("Title is required");
  else if (title.length > MAX_TITLE_LENGTH) {
    issues.push(`Title must be ${MAX_TITLE_LENGTH} characters or fewer`);
  }

  const body = merged.body.trim();
  if (!body) issues.push("Body is required");
  else if (body.length > MAX_BODY_LENGTH) {
    issues.push(`Body must be ${MAX_BODY_LENGTH} characters or fewer`);
  }

  if (!isAnnouncementLevel(merged.level)) {
    issues.push(`Level must be one of: ${ANNOUNCEMENT_LEVELS.join(", ")}`);
  }

  // An inverted window is not an empty window: it would be saved, look correct
  // in the list (both dates filled in) and never appear to anybody.
  if (merged.startsAt && merged.endsAt && Date.parse(merged.endsAt) <= Date.parse(merged.startsAt)) {
    issues.push("The end time must be after the start time");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ORDER = "ORDER BY pinned DESC, created_at DESC, id DESC";

export async function getAnnouncementById(id: string): Promise<AnnouncementRecord | null> {
  return getOne("SELECT * FROM announcements WHERE id = ?", [id], rowToAnnouncement);
}

/**
 * Every row, whatever its state — the admin list.
 *
 * Pinned first, then newest; the same order the reader gets, so the admin is
 * looking at the list in the order it will be shown in.
 */
export async function listAnnouncements(): Promise<AnnouncementRecord[]> {
  return getAll(`SELECT * FROM announcements ${ORDER}`, [], rowToAnnouncement);
}

/**
 * The rows a reader should see, most important first.
 *
 * `now` is a parameter rather than `new Date()` so a caller rendering one page
 * can ask once and compare every row against the same instant — two calls a
 * millisecond apart could disagree about a row whose window ends in between.
 */
export async function listActiveAnnouncements(now: Date = new Date()): Promise<AnnouncementRecord[]> {
  const iso = now.toISOString();
  return getAll(
    `SELECT * FROM announcements
      WHERE enabled = 1
        AND (starts_at IS NULL OR starts_at <= ?)
        AND (ends_at IS NULL OR ends_at > ?)
      ${ORDER}`,
    [iso, iso],
    rowToAnnouncement,
  );
}

/**
 * Every row a reader may know about: started, and not switched off.
 *
 * The announcement centre's list. Live first, then finished — a notice that has
 * run its course stays readable as history ("was there a notice about this?"),
 * which is the whole reason an announcement is a row and not a paragraph
 * somebody overwrites.
 *
 * `scheduled` and `off` rows are absent on purpose. A notice that has not been
 * published yet is a draft, and a draft leaking into a reader's history is worse
 * than one a reader has to ask about.
 */
export async function listPublishedAnnouncements(
  now: Date = new Date(),
): Promise<AnnouncementRecord[]> {
  const iso = now.toISOString();
  return getAll(
    `SELECT * FROM announcements
      WHERE enabled = 1
        AND (starts_at IS NULL OR starts_at <= ?)
      ORDER BY CASE WHEN ends_at IS NOT NULL AND ends_at <= ? THEN 1 ELSE 0 END,
               pinned DESC, created_at DESC, id DESC`,
    [iso, iso],
    rowToAnnouncement,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createAnnouncement(input: CreateAnnouncementInput): Promise<AnnouncementRecord> {
  const issues: string[] = [];
  const startsAt = normalizeInstant(input.startsAt, "Start time", issues);
  const endsAt = normalizeInstant(input.endsAt, "End time", issues);
  const level = input.level ?? "info";
  issues.push(...validate({ title: input.title, body: input.body, level, startsAt, endsAt }));
  if (issues.length) throw new AnnouncementValidationError(issues);

  const now = new Date().toISOString();
  const record: AnnouncementRecord = {
    id: generateId(),
    title: input.title.trim(),
    body: input.body.trim(),
    level,
    pinned: input.pinned ?? false,
    enabled: input.enabled ?? true,
    startsAt,
    endsAt,
    createdAt: now,
    updatedAt: now,
  };

  run(
    `INSERT INTO announcements
       (id, title, body, level, pinned, enabled, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.title,
      record.body,
      record.level,
      toDbBool(record.pinned),
      toDbBool(record.enabled),
      record.startsAt,
      record.endsAt,
      record.createdAt,
      record.updatedAt,
    ],
  );

  return record;
}

/**
 * Apply a patch, or return null when the row is gone.
 *
 * Merged before validating, because the fields are validated as a whole: a patch
 * that only moves `endsAt` has to be checked against the `startsAt` it did not
 * mention, or the inverted window the create path refuses would be reachable
 * from the edit path.
 */
export async function updateAnnouncement(
  id: string,
  patch: UpdateAnnouncementInput,
): Promise<AnnouncementRecord | null> {
  const existing = await getAnnouncementById(id);
  if (!existing) return null;

  const issues: string[] = [];
  const startsAt =
    patch.startsAt === undefined
      ? existing.startsAt
      : normalizeInstant(patch.startsAt, "Start time", issues);
  const endsAt =
    patch.endsAt === undefined ? existing.endsAt : normalizeInstant(patch.endsAt, "End time", issues);

  const merged: AnnouncementRecord = {
    ...existing,
    title: patch.title === undefined ? existing.title : patch.title.trim(),
    body: patch.body === undefined ? existing.body : patch.body.trim(),
    level: patch.level ?? existing.level,
    pinned: patch.pinned ?? existing.pinned,
    enabled: patch.enabled ?? existing.enabled,
    startsAt,
    endsAt,
    updatedAt: new Date().toISOString(),
  };

  issues.push(...validate(merged));
  if (issues.length) throw new AnnouncementValidationError(issues);

  run(
    `UPDATE announcements
        SET title = ?, body = ?, level = ?, pinned = ?, enabled = ?,
            starts_at = ?, ends_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      merged.title,
      merged.body,
      merged.level,
      toDbBool(merged.pinned),
      toDbBool(merged.enabled),
      merged.startsAt,
      merged.endsAt,
      merged.updatedAt,
      id,
    ],
  );

  return merged;
}

/** Returns false when there was nothing to delete, so the route can 404. */
export async function deleteAnnouncement(id: string): Promise<boolean> {
  return run("DELETE FROM announcements WHERE id = ?", [id]) > 0;
}