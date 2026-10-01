/**
 * src/lib/db/data-cache.ts
 *
 * Cached data fetching layer using React's `cache()` function.
 * 
 * Functions here are deduplicated within a single request/render cycle,
 * so multiple components can call the same data fetch without triggering
 * redundant repository queries.
 *
 * No storage changes were needed here: it wraps the repositories through
 * React's `cache()` and never touched Redis itself. Worth knowing now that the
 * data is local — `cache()` is scoped to one render, so it dedupes components
 * in the same pass, not concurrent requests hitting the database separately.
 * 
 * Usage:
 *   import { cachedGetUserById, cachedListApiKeysByUser } from "@/lib/db/data-cache";
 *   
 *   // In a server component:
 *   const user = await cachedGetUserById(userId);
 */
import { cache } from "react";
import { getUserById as _getUserById } from "./users";
import { listApiKeysByUser as _listApiKeysByUser } from "./keys";
import { aggregateByUser } from "./usage";
import { getSettings as _getSettings, type AppSettings } from "./settings";
import { buildModelCatalog as _buildModelCatalog, type ModelCatalog } from "../docs/catalog";
import type { User } from "./types";
import type { ApiKey } from "./types";
import type { UsageAggregate } from "./usage";

// Re-export types
export type { User, ApiKey };

/**
 * Cached user lookup by ID.
 * Multiple calls with the same userId within one render are deduplicated.
 */
export const cachedGetUserById = cache(async (userId: string): Promise<User | null> => {
  return _getUserById(userId);
});

/**
 * Cached API keys listing for a user.
 * Multiple calls with the same userId within one render are deduplicated.
 */
export const cachedListApiKeysByUser = cache(
  async (userId: string, limit = 200): Promise<{ keys: ApiKey[]; nextCursor: string | null }> => {
    return _listApiKeysByUser(userId, { limit });
  }
);

/**
 * Cached usage aggregation for a list of API key IDs.
 * Multiple calls with the same key IDs within one render are deduplicated.
 */
export const cachedAggregateByUser = cache(
  async (keyIds: string[]): Promise<UsageAggregate> => {
    return aggregateByUser(keyIds);
  }
);

/**
 * Settings, deduped within a render.
 *
 * The docs page reads settings twice by construction: once through the model
 * catalogue and once through `resolvePublicUrl()`. Without this they are two
 * separate queries of the same rows on the same pass.
 */
export const cachedGetSettings = cache(async (): Promise<AppSettings> => {
  return _getSettings();
});

/**
 * The model catalogue, deduped within a render.
 *
 * Deliberately NOT cached across requests. The whole point of the page is
 * that it shows what the gateway serves *now*; an operator who adds a model
 * must see it appear on the next page load, not after a TTL. A short-lived
 * cross-request cache would trade the feature's only promise for a few
 * milliseconds, and the measurement says there are few to win.
 */
export const cachedBuildModelCatalog = cache(async (): Promise<ModelCatalog> => {
  return _buildModelCatalog();
});
