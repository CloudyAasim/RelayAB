/**
 * src/lib/db/redis.ts
 *
 * Redis client singleton for the entire app.
 *
 * - Uses @upstash/redis (REST-based, no TCP socket). Works in Vercel
 *   serverless functions without code changes.
 * - In test environments we use an in-memory mock that implements the
 *   small subset of the Upstash API we actually use.
 * - Supports multiple environment variable naming conventions:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash SDK default)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN (Vercel Marketplace)
 *   - KV_URL (Upstash Redis direct)
 *   - KV_REST_API_READ_ONLY_TOKEN (Vercel KV)
 */
import { Redis } from "@upstash/redis";
import { loadConfig } from "../config";
import { createMemoryRedis, type RedisLike } from "./__mocks__/memory-redis";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let client: RedisLike | null = null;

const MEMORY_REDIS_GLOBAL_KEY = "__relayabMemoryRedis";

type RelayGlobal = typeof globalThis & {
  [MEMORY_REDIS_GLOBAL_KEY]?: RedisLike;
};

function getSharedMemoryRedis(): RedisLike {
  const g = globalThis as RelayGlobal;
  if (!g[MEMORY_REDIS_GLOBAL_KEY]) {
    g[MEMORY_REDIS_GLOBAL_KEY] = createMemoryRedis();
  }
  return g[MEMORY_REDIS_GLOBAL_KEY] as RedisLike;
}

/**
 * Get Redis URL with fallback support for multiple environment variable names.
 */
function getRedisUrl(): string | undefined {
  // Try Upstash SDK default first
  if (process.env.UPSTASH_REDIS_REST_URL?.trim()) {
    return process.env.UPSTASH_REDIS_REST_URL.trim();
  }
  // Try Vercel Marketplace naming
  if (process.env.KV_REST_API_URL?.trim()) {
    return process.env.KV_REST_API_URL.trim();
  }
  // Try Upstash Redis direct naming
  if (process.env.KV_URL?.trim()) {
    return process.env.KV_URL.trim();
  }
  return undefined;
}

/**
 * Get Redis token with fallback support for multiple environment variable names.
 */
function getRedisToken(): string | undefined {
  // Try Upstash SDK default first
  if (process.env.UPSTASH_REDIS_REST_TOKEN?.trim()) {
    return process.env.UPSTASH_REDIS_REST_TOKEN.trim();
  }
  // Try Vercel Marketplace naming
  if (process.env.KV_REST_API_TOKEN?.trim()) {
    return process.env.KV_REST_API_TOKEN.trim();
  }
  // Try Vercel KV read-only token
  if (process.env.KV_REST_API_READ_ONLY_TOKEN?.trim()) {
    return process.env.KV_REST_API_READ_ONLY_TOKEN.trim();
  }
  return undefined;
}

/**
 * Get the shared Redis client.
 */
export function getRedis(): RedisLike {
  if (client) return client;

  const cfg = loadConfig();

  if (cfg.NODE_ENV === "test" || cfg.EMULATE_VERCEL_LOCAL) {
    client = getSharedMemoryRedis();
    return client;
  }

  // Use helper functions that check multiple env var names with fallbacks
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error(
      "[relayab] Redis is not configured. Install Upstash for Redis via " +
      "Vercel Marketplace (Storage → Create Database → Upstash) to auto-" +
      "inject UPSTASH_REDIS_REST_URL (or KV_REST_API_URL, KV_URL) and " +
      "UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN). " +
      "GET /healthz reports the current state.",
    );
  }

  client = new Redis({ url, token }) as unknown as RedisLike;
  return client;
}

/**
 * Test-only: clear the cached singleton.
 */
export function __resetRedisForTest(): void {
  client = null;
  delete (globalThis as RelayGlobal)[MEMORY_REDIS_GLOBAL_KEY];
}

/**
 * Test-only: install a specific Redis-like implementation.
 */
export function __setRedisForTest(impl: RedisLike): void {
  client = impl;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export const KEY_PREFIX = "relay:";

export const k = {
  user: (id: string) => `${KEY_PREFIX}user:${id}`,
  userByUsername: (username: string) => `${KEY_PREFIX}user:by-username:${username}`,
  apiKey: (id: string) => `${KEY_PREFIX}apikey:${id}`,
  apiKeyByHash: (hash: string) => `${KEY_PREFIX}apikey:hash:${hash}`,
  apiKeyByUser: (userId: string) => `${KEY_PREFIX}apikey:by-user:${userId}`,
  provider: (id: string) => `${KEY_PREFIX}provider:${id}`,
  usageLog: (apiKeyId: string, logId: string) =>
    `${KEY_PREFIX}log:${apiKeyId}:${logId}`,
  usageLogsByKey: (apiKeyId: string) =>
    `${KEY_PREFIX}log:by-apikey:${apiKeyId}`,
  metaInitialized: () => `${KEY_PREFIX}meta:initialized`,
} as const;

/**
 * Scan all keys matching a prefix.
 */
export async function scanByPrefix(
  redis: RedisLike,
  prefix: string,
): Promise<string[]> {
  const result = await redis.scan(0, { match: `${prefix}*`, count: 100 });
  return result[1];
}
