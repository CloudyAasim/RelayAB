/**
 * src/lib/search/usage.ts
 *
 * The identity `/v1/search` writes into a usage row, and the predicate that
 * recognizes one again later.
 *
 * The predicate has to work on two shapes:
 *
 *  - `usage_logs`, which carry `capability` and can name the exact provider.
 *  - `usage_buckets`, which do **not** carry capability. Adding it would mean
 *    rebuilding the table (it is part of no primary key today, but its
 *    uniqueness and rebuild queries all assume these columns), for a feature
 *    whose volume is small.
 *
 * `model = 'web-search'` is the stable marker both shapes share. Provider ids
 * differ — an environment backend records its kind (`searxng`), a database
 * provider records its row id — so the provider cannot be the discriminator.
 * The pseudo-model is reserved for this endpoint and is not a chat model in any
 * configured provider.
 */
export const WEB_SEARCH_CAPABILITY = "web.search";
export const WEB_SEARCH_MODEL = "web-search";

/** Results per search when the caller states no preference. */
export const DEFAULT_WEB_SEARCH_LIMIT = 6;

export interface SearchUsageIdentity {
  providerId: string;
  model: string;
  /** Present on log rows; absent on bucket rows. */
  capability?: string | null;
}

export function isWebSearchUsage(row: SearchUsageIdentity): boolean {
  if (row.capability === WEB_SEARCH_CAPABILITY) return true;
  return row.model === WEB_SEARCH_MODEL;
}
