/**
 * src/lib/db/redis.ts
 *
 * Redis client singleton for the entire app.
 *
 * - Uses @upstash/redis (REST-based, no TCP socket). Works in Vercel
 *   serverless functions without code changes.
 * - In test environments we use an in-memory mock that implements the
 *   small subset of the Upstash API we actually use.
 * - Reads the Upstash URL / token from the validated config in
 *   `src/lib/config.ts`.
 */
import { Redis } from "@upstash/redis";
import { loadConfig } from "../config";
import { createMemoryRedis, type RedisLike } from "./__mocks__/memory-redis";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let client: RedisLike | null = null;

/**
 * Next.js dev server compiles each route into its own module registry, so a
 * module-level singleton would give every route its own "database". For the
 * in-memory mock we therefore hang the store off `globalThis`, which is shared
 * by all modules in the process. In production the real Upstash client is used
 * and this indirection is irrelevant (but harmless).
 */
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
 * Get the shared Redis client.
 *
 * In production this returns a real Upstash client. In test environments
 * (NODE_ENV=test) or when EMULATE_VERCEL_LOCAL=1 in development, we
 * substitute an in-process Redis mock so that tests can run without
 * external network.
 */
export function getRedis(): RedisLike {
  if (client) return client;

  const cfg = loadConfig();

  if (cfg.NODE_ENV === "test" || cfg.EMULATE_VERCEL_LOCAL) {
    // Use the in-memory mock. This means data lives only as long as the
    // Lambda/container — fine for tests; in dev with EMULATE_VERCEL_LOCAL
    // we also get predictable isolation between sessions. The store itself
    // lives on globalThis so every route bundle sees the same data.
    client = getSharedMemoryRedis();
    return client;
  }

  // Production path requires real Upstash credentials. If they are missing
  // (e.g. user has not installed Upstash for Redis Marketplace yet on Vercel),
  // throw an actionable error so /healthz can surface it instead of letting
  // the @upstash/redis SDK fail with a generic "url is required".
  if (!cfg.UPSTASH_REDIS_REST_URL || !cfg.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      "[relayab] Redis is not configured. Install Upstash for Redis via " +
      "Vercel Marketplace (Storage → Create Database → Upstash) to auto-" +
      "inject UPSTASH_REDIS_REST_URL (or KV_REST_API_URL, KV_URL) and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN). " +
      "GET /healthz reports the current state.",
    );
  }

  // Real Upstash client. Cast to RedisLike - the upstash SDK implements
  // a superset of what we use; the small type drift (e.g. `set` returns
  // `RedisValue | null` instead of `"OK" | null`) does not matter for
  // our usage.
  client = new Redis({
    url: cfg.UPSTASH_REDIS_REST_URL,
    token: cfg.UPSTASH_REDIS_REST_TOKEN,
  }) as unknown as RedisLike;

  return client;
}

/**
 * Test-only: clear the cached singleton so subsequent calls re-init.
 * Useful between test cases if you want a fresh client.
 */
export function __resetRedisForTest(): void {
  client = null;
  delete (globalThis as RelayGlobal)[MEMORY_REDIS_GLOBAL_KEY];
}

/**
 * Test-only: install a specific Redis-like implementation. Lets tests
 * provide a pre-populated mock without relying on environment toggles.
 */
export function __setRedisForTest(impl: RedisLike): void {
  client = impl;
}

// ---------------------------------------------------------------------------
// Key helpers — single source of truth for Redis key naming
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
 * Scan all keys matching a prefix. We don't expose KEYS to callers
 * directly because Upstash returns cursor strings rather than arrays.
 * The repository layer wraps this for safe use.
 */
export async function scanByPrefix(
  redis: RedisLike,
  prefix: string,
): Promise<string[]> {
  const result = await redis.scan(0, { match: `${prefix}*`, count: 100 });
  // @upstash/redis returns [cursor, string[]]
  return result[1];
}
