/**
 * src/lib/health.ts
 *
 * Pure health-check logic, kept out of the route handler so it can be unit
 * tested directly.
 *
 * This used to be duplicated — the route had one copy and the test had
 * another — which meant a change to the rules silently left the test asserting
 * the old behaviour. Sharing one implementation removes that failure mode.
 *
 * "Required" depends on where the data actually lives:
 *   - RELAY_AUTH is ALWAYS required.
 *   - Upstash URL + TOKEN are required only when a real database is in use.
 *     Outside production the default is an in-process Redis mock
 *     (`EMULATE_VERCEL_LOCAL=1`), which needs no credentials.
 */

export interface HealthEnv {
  RELAY_AUTH?: string;
  UPSTASH_REDIS_REST_URL?: string;
  KV_REST_API_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  KV_REST_API_TOKEN?: string;
  NODE_ENV?: string;
  EMULATE_VERCEL_LOCAL?: string;
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "unconfigured";
  storage: "memory" | "upstash";
  required: number;
  configured: number;
  missing?: string[];
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
 * Accept BOTH common Upstash env-var naming conventions:
 *   - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash SDK default)
 *   - KV_REST_API_URL / KV_REST_API_TOKEN                (Vercel Marketplace)
 */
export function computeHealth(env: HealthEnv): HealthReport {
  const usingMemory = isUsingMemoryStore(env);
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;

  const missing: string[] = [];
  if (!env.RELAY_AUTH?.trim()) missing.push("RELAY_AUTH");

  if (!usingMemory) {
    if (!url?.trim()) missing.push("UPSTASH_REDIS_REST_URL (or KV_REST_API_URL)");
    if (!token?.trim()) {
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

  return {
    ok: missing.length === 0,
    status,
    storage: usingMemory ? "memory" : "upstash",
    required,
    configured,
    missing: missing.length > 0 ? missing : undefined,
  };
}
