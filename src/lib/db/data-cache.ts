/**
 * src/lib/db/data-cache.ts
 *
 * Cached data fetching layer using React's `cache()` function.
 * 
 * Functions here are deduplicated within a single request/render cycle,
 * so multiple components can call the same data fetch without triggering
 * redundant Redis calls.
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
import { aggregateByUser as _aggregateByUser } from "./usage";
import type { User } from "./types";
import type { ApiKey } from "./types";

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
  async (keyIds: string[]): Promise<{
    totalTokens: number;
    totalCredits: number;
    creditsUsed: number;
    byModel: Record<string, { tokens: number; credits: number }>;
  }> => {
    return _aggregateByUser(keyIds);
  }
);
