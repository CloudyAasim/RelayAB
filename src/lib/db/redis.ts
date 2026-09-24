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
export type { RedisLike };

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

/**
 * Interpret a boolean we persist as `"1"` / `"0"`.
 *
 * `@upstash/redis` deserializes hash values on read, so a stored `"1"` comes
 * back as the *number* `1`. Comparing against the string `"1"` therefore reads
 * every flag as false — which silently disables features (provider protocol
 * faces, disabled-account checks). Always normalise before comparing.
 *
 * @param fallback returned when the field is absent or empty.
 */
export function readStoredFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

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
  /** Running per-key totals (tokens / credits / requests), kept in sync by recordUsage. */
  usageTotalsByKey: (apiKeyId: string) =>
    `${KEY_PREFIX}stats:key:${apiKeyId}`,
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

// ---------------------------------------------------------------------------
// Batched reads
// ---------------------------------------------------------------------------

/**
 * How many commands to put in one pipeline request.
 *
 * A pipeline travels as a single HTTP request, so this is a request-size and
 * server-limit guard, not a latency tradeoff: one chunk is still one round
 * trip, and the chunks are issued concurrently below.
 */
const PIPELINE_CHUNK = 100;

/**
 * HGETALL many keys with one round trip per chunk instead of one per key.
 *
 * Every command against a REST-backed Redis is an HTTP request. Reading N
 * records with `Promise.all` therefore costs N requests and dominates list
 * pages as soon as there is more than a handful of rows; a MULTI pipeline
 * carries the whole chunk in a single request. Results are returned in the
 * same order as `keys`, with `null` for keys that do not exist or hold a
 * non-hash type.
 */
export async function hgetallMany(
  redis: RedisLike,
  keys: readonly string[],
): Promise<Array<Record<string, string> | null>> {
  if (keys.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += PIPELINE_CHUNK) {
    chunks.push(keys.slice(i, i + PIPELINE_CHUNK));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const pipeline = redis.multi();
      for (const key of chunk) pipeline.hgetall(key);
      return pipeline.exec();
    }),
  );

  return chunkResults.flat().map((raw) =>
    raw && typeof raw === "object" ? (raw as Record<string, string>) : null,
  );
}
