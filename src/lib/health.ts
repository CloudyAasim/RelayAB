/**
 * src/lib/health.ts
 *
 * Pure health-check logic, kept out of the route handler so it can be unit
 * tested directly.
 *
 * "Required" depends on where the data actually lives:
 *   - RELAY_AUTH is ALWAYS required.
 *   - Upstash URL + TOKEN are required only when a real database is in use.
 *     Outside production the default is an in-process Redis mock
 *     (`EMULATE_VERCEL_LOCAL=1`), which needs no credentials.
 */

export interface HealthEnv {
  RELAY_AUTH?: string;
  // Upstash SDK default
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  // Vercel KV / Upstash Marketplace
  KV_REST_API_URL?: string;
  KV_REST_API_TOKEN?: string;
  KV_REST_API_READ_ONLY_TOKEN?: string;
  // Upstash Redis direct
  KV_URL?: string;
  REDIS_URL?: string;
  // Legacy / other providers
  REDIS_HOST?: string;
  REDIS_PASSWORD?: string;
  NODE_ENV?: string;
  EMULATE_VERCEL_LOCAL?: string;
  /** Vercel-provided short SHA of the running deployment. */
  VERCEL_GIT_COMMIT_SHA?: string;
  /** Fallback build identifier set by the operator when running off Vercel. */
  RELAY_BUILD_ID?: string;
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "unconfigured";
  storage: "memory" | "upstash";
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

/**
 * Accept ALL common Upstash/Redis env-var naming conventions:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash SDK default)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN               (Vercel Marketplace)
 *   - KV_URL / REDIS_URL                               (Upstash Redis direct)
 *   - KV_REST_API_READ_ONLY_TOKEN                       (Vercel KV)
 */
export function computeHealth(env: HealthEnv): HealthReport {
  const usingMemory = isUsingMemoryStore(env);

  // Try multiple possible URL variables
  const url =
    env.UPSTASH_REDIS_REST_URL ??
    env.KV_REST_API_URL ??
    env.KV_URL ??
    undefined;

  // Try multiple possible TOKEN variables
  const token =
    env.UPSTASH_REDIS_REST_TOKEN ??
    env.KV_REST_API_TOKEN ??
    env.KV_REST_API_READ_ONLY_TOKEN ??
    undefined;

  // If we have a REDIS_URL, parse it for connection info
  const hasRedisUrl = hasValue(env.REDIS_URL);

  const missing: string[] = [];
  if (!env.RELAY_AUTH?.trim()) missing.push("RELAY_AUTH");

  if (!usingMemory) {
    // Check if we have any usable database configuration
    const hasUrl = hasValue(url);
    const hasToken = hasValue(token);

    // If we have KV_URL or REDIS_URL, we might be able to use it
    if (!hasUrl && !hasRedisUrl) {
      missing.push("UPSTASH_REDIS_REST_URL (or KV_REST_API_URL / KV_URL / REDIS_URL)");
    }
    if (!hasToken && !hasRedisUrl) {
      missing.push("UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN)");
    }
  }

  const required = usingMemory ? 1 : 3;
  const configured = required - missing.length;
  const status: HealthReport["status"] =
    missing.length === 0
      ? "ok"
      : missing.length === required
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
    storage: usingMemory ? "memory" : "upstash",
    required,
    configured,
    missing: missing.length > 0 ? missing : undefined,
    revision,
  };
}
