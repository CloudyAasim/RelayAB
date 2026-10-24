/**
 * The states a key can be in, and the one rule that picks between them.
 *
 * There are four, not two, and the two that are easy to forget are the ones
 * that lie:
 *
 *  - **forced off** — an administrator disabled the key. It wins over
 *    everything else, because that override is exactly the thing that must not
 *    itself be overridden.
 *  - **expired** — the key's own end date has passed. The row can still say
 *    "enabled", because `enabled` is a switch somebody flipped, not a fact
 *    about the clock. The gateway refuses the key anyway
 *    (`lib/auth/apikey.ts`), so a panel that calls an expired key "enabled" is
 *    telling the user the opposite of the truth.
 *
 * The order is the gateway's order — force-disabled, then disabled, then
 * expired — because the question being answered is the same one in both
 * places: *can this key serve traffic?* Once there is one answer, it is asked
 * once: this module is the only place the question is put, and
 * `components/keys/KeyStatusBadge.tsx` is the only place the answer is drawn.
 */

/** The four answers. */
export type KeyStatus = "enabled" | "disabled" | "expired" | "forceDisabled";

/** The parts of a key this rule reads. */
export interface KeyStatusInput {
  enabled?: boolean;
  forceDisabled?: boolean;
  expiresAt?: string | null;
}

/**
 * The key's status.
 *
 * `now` is a parameter so the rule can be asked about a moment other than the
 * present — an expiry test needs one, and a test that cannot choose the moment
 * can only test "not expired", which is the half that was never in doubt.
 */
export function keyStatus(key: KeyStatusInput, now: number = Date.now()): KeyStatus {
  // The admin's override first: a forced-off key must never be reported as
  // merely expired or merely switched off, or the person who locked it cannot
  // tell that it was locked.
  if (key.forceDisabled === true) return "forceDisabled";

  // `!== true` rather than a truthiness test: `enabled` is a stored flag, and a
  // row that never had one is off, not on.
  if (key.enabled !== true) return "disabled";

  // A key with no end date does not expire. An unparseable date does not
  // expire either — it is a value nobody can act on, and refusing the key over
  // it would be a failure with no way out.
  if (key.expiresAt) {
    const at = Date.parse(key.expiresAt);
    if (Number.isFinite(at) && at <= now) return "expired";
  }

  return "enabled";
}
