/**
 * src/lib/quota/credits.ts
 *
 * The single usage unit in RelayAB is the **积分 (credit)**.
 *
 * Storage granularity is 0.001 积分: every amount kept in Redis / returned by
 * the API is an integer count of these units. That keeps all arithmetic on
 * integers (no floating-point drift) while still letting a very cheap request
 * consume a fraction of a single 积分.
 *
 * Example: 1000 units = 1 积分, 1 unit = 0.001 积分.
 */

/** How many stored units make up one 积分. */
export const CREDIT_SCALE = 1000;

/** Convert 积分 (may be fractional) into the integer unit used for storage. */
export function creditsToUnits(credits: number): number {
  if (!Number.isFinite(credits)) return 0;
  return Math.round(credits * CREDIT_SCALE);
}

/** Convert stored units back into 积分 (fractional; for display only). */
export function unitsToCredits(units: number): number {
  if (!Number.isFinite(units)) return 0;
  return units / CREDIT_SCALE;
}
