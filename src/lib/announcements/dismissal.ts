/**
 * src/lib/announcements/dismissal.ts
 *
 * Which announcements this browser has already closed.
 *
 * A dismissal is a per-browser reading preference, not an account setting: the
 * person who closed the maintenance notice on their laptop may well want to see
 * it on their phone, and nothing on the server needs to know either way. So it
 * lives in localStorage, the same place the assistant's display preference does.
 *
 * Ids, not "dismiss everything up to now": a *new* announcement has to show up
 * even to a reader who has dismissed five others, and an id only stops matching
 * when that announcement itself is gone.
 */

const STORAGE_KEY = "relayab-announcements-dismissed";

/**
 * How many ids to remember.
 *
 * The list only ever grows, and nothing prunes it except this cap. Ids are short
 * and a deployment publishes announcements by the handful, so keeping the last
 * few hundred is generous and keeps the stored value a few kilobytes.
 */
const MAX_REMEMBERED = 200;

/**
 * Read a stored value into a list of ids.
 *
 * A corrupt or hand-edited value reads as "nothing dismissed" rather than as an
 * error: the failure of a dismissal list is a notice shown once more, which is
 * the direction that cannot hide anything from the reader.
 */
export function parseDismissed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function readDismissedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return parseDismissed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode, or storage disabled: nothing is remembered, so every live
    // announcement shows. That is the safe failure.
    return [];
  }
}

export function writeDismissedIds(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(ids.slice(-MAX_REMEMBERED)),
    );
  } catch {
    // Nothing to do: the dismissal will not outlive this session.
  }
}