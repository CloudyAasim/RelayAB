/**
 * src/lib/announcements/types.ts
 *
 * The announcement shapes that **both** sides of the boundary agree on.
 *
 * Split out from `lib/db/announcements.ts` because that module imports the
 * SQLite layer, and the banner is a client component: importing the repository
 * for its types alone would drag `node:sqlite` into the browser bundle. So the
 * vocabulary — the four levels, the public shape, the state a window puts a row
 * in — lives here, client-safe, and the repository reads it.
 */

/**
 * How urgent a notice is.
 *
 * Four, not a free-form string: the level picks a colour and nothing else, and
 * a colour with no key behind it is a colour nobody can theme or translate.
 * `info` carries the ordinary case, so most announcements need no decision.
 */
export const ANNOUNCEMENT_LEVELS = ["info", "success", "warning", "danger"] as const;
export type AnnouncementLevel = (typeof ANNOUNCEMENT_LEVELS)[number];

export function isAnnouncementLevel(value: unknown): value is AnnouncementLevel {
  return typeof value === "string" && (ANNOUNCEMENT_LEVELS as readonly string[]).includes(value);
}

/** Longest title accepted. It is one line above a paragraph, not a document. */
export const MAX_TITLE_LENGTH = 120;

/**
 * Longest body accepted.
 *
 * The same 20,000 the settings field it replaces allowed, so migrating that text
 * cannot truncate something an operator already had.
 */
export const MAX_BODY_LENGTH = 20_000;

/**
 * What a reader receives.
 *
 * `enabled` is absent on purpose: this shape only ever describes rows that are
 * already active, and a reader that could see the switch would have to
 * re-implement the decision — and get "switched off" and "expired" mixed up.
 * The window stays, so a surface can say when the message stops applying.
 */
export interface PublicAnnouncement {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  pinned: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

/**
 * Where a row is in its life, from the reader's point of view.
 *
 * Derived rather than stored: a stored copy would be wrong the moment a clock
 * ticked, and nothing would rewrite it. The four states are the four questions
 * an operator asks of a scheduled notice — will it show, is it showing, has it
 * finished, or did I switch it off — and they are mutually exclusive, which is
 * what makes them one value instead of three booleans.
 */
export type AnnouncementState = "live" | "scheduled" | "expired" | "off";

export function announcementState(
  row: {
    enabled: boolean;
    startsAt: string | null;
    endsAt: string | null;
  },
  now: Date = new Date(),
): AnnouncementState {
  if (!row.enabled) return "off";
  const at = now.getTime();
  if (row.startsAt) {
    const starts = Date.parse(row.startsAt);
    // An unparseable start is not a reason to hide the notice: `Date.parse`
    // returning NaN would poison every comparison, so it reads as "no bound"
    // rather than as "always in the future".
    if (!Number.isNaN(starts) && starts > at) return "scheduled";
  }
  if (row.endsAt) {
    const ends = Date.parse(row.endsAt);
    if (!Number.isNaN(ends) && ends <= at) return "expired";
  }
  return "live";
}