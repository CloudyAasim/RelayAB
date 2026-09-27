/**
 * src/lib/usage/view-prefs.ts
 *
 * The usage screens are driven entirely by query params (range / scope /
 * metric / group / the selected key or model). Users expect the screen to open
 * on whatever they looked at last, so middleware stores the active params in a
 * cookie and replays them when the URL has none.
 *
 * Only the keys below are persisted, and stored values are re-filtered before
 * replay, so a crafted cookie cannot smuggle arbitrary query params back in.
 */

/** Query params that make up a usage view. Order is irrelevant. */
export const USAGE_VIEW_KEYS = [
  "range",
  "scope",
  "keyId",
  "model",
  "metric",
  "group",
] as const;

/** Cookie name for a usage-screen path, or null when the path is not one. */
export function usageViewCookieName(pathname: string): string | null {
  if (pathname === "/admin/usage") return "relay_usage_view_admin";
  if (pathname === "/dashboard/usage") return "relay_usage_view_user";
  return null;
}

/**
 * Serialize the persistable subset of `searchParams` to a query string, or
 * `null` when none of the view keys are present.
 */
export function usageViewFromParams(searchParams: URLSearchParams): string | null {
  const keep = new URLSearchParams();
  for (const key of USAGE_VIEW_KEYS) {
    const value = searchParams.get(key);
    if (value) keep.set(key, value);
  }
  const serialized = keep.toString();
  return serialized || null;
}
