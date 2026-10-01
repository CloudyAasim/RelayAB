/**
 * src/lib/health.ts
 *
 * Pure health-check logic, kept out of the route handler so it can be unit
 * tested directly.
 *
 * "Required" depends on where the data actually lives:
 *   - RELAY_AUTH is ALWAYS required.
 *   - A Redis connection is required only when a real database is in use.
 *     Outside production the default is an in-process Redis mock
 *     (`EMULATE_VERCEL_LOCAL=1`), which needs no credentials.
 *
 * The database side accepts either transport, matching the precedence in
 * `lib/db/redis.ts`:
 *   - `REDIS_URL` (redis:// or rediss://)  -> TCP via ioredis  -> "redis"
 *   - `UPSTASH_REDIS_REST_*` / `KV_*`       -> HTTP REST       -> "upstash"
 *
 * Anything else is reported as missing rather than silently assumed, so a
 * half-configured deployment shows up here instead of as a burst of 500s.
 */

export interface HealthEnv {
  RELAY_AUTH?: string;
  // Self-hosted TCP connection string (ioredis). Takes precedence.
  REDIS_URL?: string;
  // Upstash SDK default
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Vercel KV / Upstash Marketplace
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  KV_REST_API_READ_ONLY_TOKEN?: string;
  // Upstash Redis direct
  KV_URL?: string;
  NODE_ENV?: string;
  EMULATE_VERCEL_LOCAL?: string;
  /**
   * Vercel-provided short SHA of the running deployment.
   *
   * Only present on Vercel. On a self-hosted server it is absent and
   * RELAY_BUILD_ID below takes over.
   */
  VERCEL_GIT_COMMIT_SHA?: string;
  /** Fallback build identifier set by the operator when running off Vercel. */
  RELAY_BUILD_ID?: string;
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "unconfigured";
  storage: "memory" | "redis" | "upstash";
  required: number;
  configured: number;
  missing?: string[];
  /** Short SHA (or operator-supplied build id) of the running build, or null. */
  revision: string | null;
}

/**
 * Mirror the default applied in `lib/config.ts`:
 * `EMULATE_VERCEL_LOCAL` defaults to "1" outside production, "0" inside it.
 */
export function isUsingMemoryStore(env: HealthEnv): boolean {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    return env.EMULATE_VERCEL_LOCAL === "1";
  }
  return env.EMULATE_VERCEL_LOCAL !== "0";
}

/**
 * Presence check for an env var.
 *
 * Any non-empty value counts as configured. An earlier version additionally
 * required tokens to be longer than 10 characters ("looks like a token"),
 * which made `/healthz` report `degraded` for short-but-valid tokens and broke
 * the contract the tests encode: present == configured. Whether a URL is
 * actually reachable is not something a health check can decide by looking at
 * the string — the redis client surfaces that at request time.
 */
function hasValue(val?: string): boolean {
  return Boolean(val?.trim());
}

function isTcpUrl(url: string): boolean {
  return url.startsWith("redis://") || url.startsWith("rediss://");
}

/**
 * Decide which transport this environment would use, and what (if anything) is
 * still missing for it.
 *
 * Mirrors `resolveRedisTransport()` in `lib/db/redis.ts`: a `redis://` URL
 * wins outright, otherwise the Upstash-style URL + token pair is required.
 * Keeping the two in step matters — when they drifted, `/healthz` happily
 * reported `ok` for a `REDIS_URL`-only box while every data route threw
 * "Redis is not configured".
 */
function resolveStorage(env: HealthEnv): {
  storage: HealthReport["storage"];
  missing: string[];
} {
  if (isUsingMemoryStore(env)) {
    return { storage: "memory", missing: [] };
  }

  const missing: string[] = [];

  const tcp = env.REDIS_URL?.trim();
  if (tcp) {
    // A TCP connection string is self-contained: host, port and any password
    // are inline, so there is no second variable to check.
    if (!isTcpUrl(tcp)) missing.push("REDIS_URL (must start with redis:// or rediss://)");
    return { storage: "redis", missing };
  }

  const url =
    env.UPSTASH_REDIS_REST_URL?.trim() ??
    env.KV_REST_API_URL?.trim() ??
    env.KV_URL?.trim();

  const token =
    env.UPSTASH_REDIS_REST_TOKEN?.trim() ??
    env.KV_REST_API_TOKEN?.trim() ??
    env.KV_REST_API_READ_ONLY_TOKEN?.trim();

  if (!hasValue(url)) {
    missing.push("REDIS_URL (or UPSTASH_REDIS_REST_URL / KV_REST_API_URL / KV_URL)");
  }
  if (!hasValue(token)) {
    missing.push("UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)");
  }

  return { storage: "upstash", missing };
}

export function computeHealth(env: HealthEnv): HealthReport {
  const { storage, missing: storageMissing } = resolveStorage(env);

  const missing: string[] = [];
  if (!hasValue(env.RELAY_AUTH)) missing.push("RELAY_AUTH");
  missing.push(...storageMissing);

  /**
   * How many variables this transport actually needs. The TCP path is one
   * variable fewer than the REST path because a `redis://` URL carries its
   * own password, while Upstash splits host and token across two.
   */
  const required =
    storage === "memory" ? 1 : storage === "redis" ? 2 : 3;
  const configured = required - missing.length;
  const status: HealthReport["status"] =
    missing.length === 0
      ? "ok"
      : missing.length >= required
        ? "unconfigured"
        : "degraded";

  const rawSha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  // Short SHA only — never expose the full 40-char commit hash on a public
  // endpoint, and never include it in error paths.
  const revision =
    (rawSha && rawSha.length >= 7 ? rawSha.slice(0, 7) : null) ??
    env.RELAY_BUILD_ID?.trim() ??
    null;

  return {
    ok: missing.length === 0,
    status,
    storage,
    required,
    configured,
    missing: missing.length > 0 ? missing : undefined,
    revision,
  };
}
