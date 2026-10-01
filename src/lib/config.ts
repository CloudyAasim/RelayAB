/**
 * src/lib/config.ts
 *
 * Centralized, validated configuration for RelayAB.
 *
 * Configuration philosophy (inspired by ai-relay):
 * - 3 env vars to start: RELAY_AUTH + Upstash URL/Token
 * - Everything else is auto-derived at runtime.
 *
 * Required (minimum):
 *   RELAY_AUTH                  - master password (admin login + key derivation seed)
 *   RELAY_PUBLIC_URL            - public base URL shown to users (e.g. https://relay.example.com)
 *
 * Database — exactly one of:
 *   REDIS_URL                   - self-hosted Redis/Valkey, spoken over TCP by ioredis
 *                                 (the normal choice on a self-hosted Debian box)
 *   UPSTASH_REDIS_REST_URL      - Upstash REST endpoint (hosted alternative)
 *   UPSTASH_REDIS_REST_TOKEN    - Upstash REST token
 *
 * Optional:
 *   RELAY_MASTER_KEY_HEX        - explicit master key (otherwise derived from RELAY_AUTH)
 *   RELAY_ADMIN_USERNAME         - admin username (default: "admin")
 *   OPENAI_KEYS                  - "sk-1,sk-2" — auto-create OpenAI provider
 *   ANTHROPIC_KEYS               - "sk-ant-1,sk-ant-2" — auto-create Anthropic provider
 *   OPENAI_BASE_URL              - override OpenAI endpoint (for Azure, proxies, etc.)
 *   ANTHROPIC_BASE_URL           - override Anthropic endpoint
 *   EMULATE_VERCEL_LOCAL         - "1" to use the in-memory store (development only)
 */
import { z } from "zod";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a 64-hex-char (32-byte) secret from `RELAY_AUTH` using HMAC-style
 * keyed hashing. Used to bootstrap SESSION_PASSWORD and (optionally) the
 * AES master key when RELAY_MASTER_KEY_HEX is not set.
 *
 * WARNING: if you change `RELAY_AUTH`, all derived values change → existing
 * sessions + encrypted upstream keys become inaccessible. This is intentional
 * ("set everything" = update all keys together).
 */
function deriveHex(authSecret: string, label: string): string {
  return createHash("sha256")
    .update(`relayab:${label}:${authSecret}`)
    .digest("hex");
}

/**
 * Convert empty strings to undefined for proper Zod optional handling.
 * Zod's .optional() only skips validation when value is undefined, not empty string.
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}



// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  // Required at startup — without this the app cannot start.
  RELAY_AUTH: z.string().min(8, "RELAY_AUTH must be at least 8 characters."),
  /**
   * Public base URL of this instance.
   *
   * OPTIONAL — and normally unnecessary. It is only worth setting when the
   * URL users should paste into their clients is not the URL they reached
   * this deployment on (custom domain in front of a *.vercel.app origin, a
   * reverse proxy, etc.).
   *
   * Resolution order when unset (see `resolvePublicUrl`):
   *   1. VERCEL_URL          — injected automatically by Vercel
   *   2. request headers     — x-forwarded-proto + x-forwarded-host / host
   *   3. http://localhost:3000 — local dev
   *
   * Keeping this optional matters: the Deploy Button asks for exactly one
   * value, and a self-hoster shouldn't have to tell the app its own address.
   */
  RELAY_PUBLIC_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://") || v.startsWith("http://"), {
      message: "RELAY_PUBLIC_URL must be an http(s) URL.",
    })
    .optional(),

  // Optional at startup — at least one Redis connection must resolve before
  // any /api or /admin route can work. /healthz reports which one is present.
  //
  // Two transports are supported, and they are mutually independent:
  //   1. REDIS_URL          — standard connection string, spoken over TCP by
  //                           ioredis. This is the path for a self-hosted
  //                           deployment (Valkey/Redis on 127.0.0.1).
  //   2. UPSTASH_REDIS_REST_* — Upstash's HTTP/REST API, kept for hosted
  //                           deployments that do not expose a TCP port.
  // REDIS_URL wins when both are present.
  UPSTASH_REDIS_REST_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://") || v.startsWith("http://localhost"), {
      message: "UPSTASH_REDIS_REST_URL must be a valid URL.",
    })
    .optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  /**
   * Standard Redis connection string for a self-hosted server.
   *
   * When set, RelayAB connects over a normal TCP socket with ioredis instead
   * of the Upstash REST API. This is the intended configuration off Vercel,
   * where a local Valkey/Redis listens on 127.0.0.1: a TCP connection is one
   * hop shorter and does not pay HTTP-request overhead per command.
   *
   * Use `rediss://` for a TLS-terminated endpoint. The password, if any, goes
   * inline: `redis://:<password>@127.0.0.1:6379`.
   */
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/.+/, {
      message: "REDIS_URL must start with redis:// or rediss://",
    })
    .optional(),

  // Optional with safe defaults
  RELAY_MASTER_KEY_HEX: z.string().optional(),
  RELAY_ADMIN_USERNAME: z.string().min(1).default("admin"),
  /**
   * Default UI locale. The user can override via the language switcher
   * in the footer (cookie + localStorage persistence). Defaults to
   * "zh-CN" so that fresh deployments of this Chinese-origin project
   * don't accidentally fall back to English when the browser's
   * Accept-Language header starts with "en".
   */
  RELAY_DEFAULT_LOCALE: z.enum(["zh-CN", "en"]).default("zh-CN"),
  OPENAI_KEYS: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  ANTHROPIC_KEYS: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  EMULATE_VERCEL_LOCAL: z
    .enum(["0", "1"])
    .optional()
    .default("0")
    .transform((v) => v === "1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let cachedConfig: z.infer<typeof schema> | null = null;

/**
 * Resolve and validate the full configuration.
 *
 * Derives SESSION_PASSWORD and RELAY_MASTER_KEY_HEX from RELAY_AUTH
 * when not explicitly set. See `getSessionPassword()` / `getMasterKey()`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): z.infer<typeof schema> {
  if (cachedConfig) return cachedConfig;

  const isTest = env.NODE_ENV === "test";
  const isProd = env.NODE_ENV === "production";

  // Provide safe defaults for tests.
  const enriched: Record<string, string | undefined> = {
    RELAY_AUTH:
      env.RELAY_AUTH ??
      (isTest ? "test-relay-auth-must-be-8-chars-long-padding" : undefined),
    // Left undefined when unset; `resolvePublicUrl()` derives a sensible
    // value from VERCEL_URL or the incoming request at render time.
    RELAY_PUBLIC_URL: emptyToUndefined(env.RELAY_PUBLIC_URL),
    // Vercel Upstash Marketplace injects KV_REST_API_* (legacy Vercel KV
    // naming). The Upstash SDK docs use UPSTASH_REDIS_REST_*. Accept either.
    UPSTASH_REDIS_REST_URL: emptyToUndefined(
      env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL ?? env.KV_URL) ??
      (isTest ? "http://localhost:13700" : undefined),
    UPSTASH_REDIS_REST_TOKEN: emptyToUndefined(
      env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN ?? env.KV_REST_API_READ_ONLY_TOKEN) ??
      (isTest ? "test-token" : undefined),
    // Self-hosted path. Empty string disables it so a stray blank value in an
    // env file cannot make the schema fall back to the REST branch silently.
    REDIS_URL: emptyToUndefined(env.REDIS_URL),
    RELAY_MASTER_KEY_HEX: env.RELAY_MASTER_KEY_HEX,
    RELAY_ADMIN_USERNAME: emptyToUndefined(env.RELAY_ADMIN_USERNAME) ?? "admin",
    // Passed through explicitly: zod's `.default()` only fires when the key
    // is absent, so omitting it here would silently ignore the env var and
    // pin every deployment to zh-CN.
    RELAY_DEFAULT_LOCALE: emptyToUndefined(env.RELAY_DEFAULT_LOCALE),
    OPENAI_KEYS: env.OPENAI_KEYS,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    ANTHROPIC_KEYS: env.ANTHROPIC_KEYS,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    EMULATE_VERCEL_LOCAL: env.EMULATE_VERCEL_LOCAL ?? (isProd ? "0" : "1"),
    NODE_ENV: env.NODE_ENV ?? "development",
  };

  const result = schema.safeParse(enriched);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `[relayab] Invalid configuration. Fix the following env vars:\n${issues}\n\n` +
        `Only RELAY_AUTH is strictly required.\n` +
        `Note: the app also needs a Redis connection. Either set REDIS_URL\n` +
        `(e.g. redis://:password@127.0.0.1:6379 for a self-hosted Valkey/Redis),\n` +
        `or provide UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for a\n` +
        `hosted Upstash database. Without one, the app starts but all data routes\n` +
        `fail; /healthz reports the state.\n` +
 +
        `See .env.example for the full list.`,
    );
  }

  cachedConfig = result.data;
  return cachedConfig;
}




/** Reset cached config. Test-only helper. */
export function __resetConfigForTest(): void {
  cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

export function isProduction(): boolean {
  return loadConfig().NODE_ENV === "production";
}

export function isEmulatorEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.EMULATE_VERCEL_LOCAL && cfg.NODE_ENV !== "production";
}

/**
 * Get the session encryption password.
 *
 * Always derived from `RELAY_AUTH` (there is no `SESSION_PASSWORD` env var
 * anymore). Deriving keeps sessions valid across serverless cold starts,
 * since `RELAY_AUTH` is the only stable input.
 *
 * Rotating `RELAY_AUTH` therefore invalidates every existing session.
 */
export function getSessionPassword(): string {
  const cfg = loadConfig();
  return deriveHex(cfg.RELAY_AUTH, "session-v1");
}

/**
 * Get the AES-256 master key (32 bytes) used to encrypt upstream
 * provider keys at rest.
 *
 * Priority:
 *   1. If `RELAY_MASTER_KEY_HEX` is set explicitly, use it.
 *   2. Otherwise, derive deterministically from RELAY_AUTH.
 *
 * Note: rotating RELAY_MASTER_KEY_HEX (or RELAY_AUTH) invalidates
 * all existing encrypted provider keys. Re-add them via the admin UI
 * after rotation, or run scripts/rotate-master-key.ts.
 */
export function getMasterKey(): Buffer {
  const cfg = loadConfig();
  if (cfg.RELAY_MASTER_KEY_HEX) {
    return Buffer.from(cfg.RELAY_MASTER_KEY_HEX, "hex");
  }
  return Buffer.from(deriveHex(cfg.RELAY_AUTH, "master-v1"), "hex");
}

/**
 * True if the master key is explicitly set (vs derived).
 * Used to warn admins that rotating RELAY_AUTH will invalidate upstream keys.
 */
export function isMasterKeyExplicit(): boolean {
  return Boolean(loadConfig().RELAY_MASTER_KEY_HEX);
}

/**
 * Parse the OPENAI_KEYS env var into a list of API keys.
 * Empty array if not set.
 */
export function getOpenAIKeys(): string[] {
  const cfg = loadConfig();
  if (!cfg.OPENAI_KEYS) return [];
  return cfg.OPENAI_KEYS.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse the ANTHROPIC_KEYS env var into a list of API keys.
 */
export function getAnthropicKeys(): string[] {
  const cfg = loadConfig();
  if (!cfg.ANTHROPIC_KEYS) return [];
  return cfg.ANTHROPIC_KEYS.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Strip a trailing slash so callers can safely append "/v1".
 */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Best-effort public base URL using ONLY environment variables.
 *
 * Order:
 *   1. RELAY_PUBLIC_URL — explicit override, for custom domains/proxies
 *   2. VERCEL_URL       — legacy fallback. Vercel used to inject this
 *                         automatically; it is still honoured so that
 *                         rolling back to the old deployment needs no code
 *                         change, but a self-hosted box should set
 *                         RELAY_PUBLIC_URL instead.
 *   3. http://localhost:3000 — local dev
 *
 * This cannot see the request, so on a self-hosted box behind an unknown
 * domain it falls back to localhost. Server components should prefer
 * `resolvePublicUrl()` from `lib/public-url.ts`, which can also read the
 * incoming Host header and therefore gets the right answer with no
 * configuration at all.
 */
export function getPublicUrl(): string {
  const cfg = loadConfig();
  if (cfg.RELAY_PUBLIC_URL) return trimSlash(cfg.RELAY_PUBLIC_URL);

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) {
    // VERCEL_URL is a bare host ("my-app.vercel.app"), not a full URL.
    const host = vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return `https://${host}`;
  }

  return "http://localhost:3000";
}

/**
 * Build a URL relative to the public base, e.g. publicUrl("/v1").
 * Env-only; see `resolvePublicUrl()` for the request-aware variant.
 */
export function publicUrl(path: string): string {
  const base = getPublicUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}
