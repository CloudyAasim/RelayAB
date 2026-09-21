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
 *   UPSTASH_REDIS_REST_URL      - database (auto-injected by Vercel Marketplace)
 *   UPSTASH_REDIS_REST_TOKEN    - database token
 *
 * Optional:
 *   RELAY_MASTER_KEY_HEX        - explicit master key (otherwise derived from RELAY_AUTH)
 *   RELAY_ADMIN_USERNAME         - admin username (default: "admin")
 *   OPENAI_KEYS                  - "sk-1,sk-2" — auto-create OpenAI provider
 *   ANTHROPIC_KEYS               - "sk-ant-1,sk-ant-2" — auto-create Anthropic provider
 *   OPENAI_BASE_URL              - override OpenAI endpoint (for Azure, proxies, etc.)
 *   ANTHROPIC_BASE_URL           - override Anthropic endpoint
 *   VERCEL_PROTECTION_BYPASS     - bypass Vercel deployment protection
 *   EMULATE_VERCEL_LOCAL         - "1" to enable embedded Vercel REST emulator
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  // Required at startup — without this the app cannot start.
  RELAY_AUTH: z.string().min(8, "RELAY_AUTH must be at least 8 characters."),
  // Public base URL of this instance. Surfaced to logged-in users in the
  // docs page so they can copy it into their OpenAI/Anthropic-compatible
  // clients. Treated as required at startup (with a safe localhost default
  // in dev / test) so the user-facing UI always has something to render.
  RELAY_PUBLIC_URL: z
    .string()
    .url()
    .refine(
      (v) => v.startsWith("https://") || v.startsWith("http://"),
      // Transport-level policy (https required in production, http allowed
      // for localhost / LAN self-hosting) is enforced after parsing, where
      // NODE_ENV is available. Here we only check the scheme is http(s).
      {
        message: "RELAY_PUBLIC_URL must be an http(s) URL.",
      },
    ),

  // Optional at startup — these are auto-injected by the Upstash for Redis
  // Vercel Marketplace once you install it on the project. They are required
  // for the app to actually function (any /api or /admin route touches
  // Redis). The /healthz endpoint reports whether they are currently present.
  // The Deploy Button only asks for RELAY_AUTH so you can deploy first,
  // then install Upstash Marketplace.
  UPSTASH_REDIS_REST_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://") || v.startsWith("http://localhost"), {
      message: "UPSTASH_REDIS_REST_URL must be a valid URL.",
    })
    .optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

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
  VERCEL_PROTECTION_BYPASS: z.string().optional(),

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
    // Default to localhost for dev / test so the app always boots.
    // Production deployments MUST set this (see .env.example).
    RELAY_PUBLIC_URL:
      env.RELAY_PUBLIC_URL ??
      (isProd ? undefined : "http://localhost:3000"),
    // Vercel Upstash Marketplace injects KV_REST_API_* (legacy Vercel KV
    // naming). The Upstash SDK docs use UPSTASH_REDIS_REST_*. Accept either.
    UPSTASH_REDIS_REST_URL:
      env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL ??
      (isTest ? "http://localhost:13700" : undefined),
    UPSTASH_REDIS_REST_TOKEN:
      env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN ??
      (isTest ? "test-token" : undefined),
    RELAY_MASTER_KEY_HEX: env.RELAY_MASTER_KEY_HEX,
    RELAY_ADMIN_USERNAME: env.RELAY_ADMIN_USERNAME ?? "admin",
    // Passed through explicitly: zod's `.default()` only fires when the key
    // is absent, so omitting it here would silently ignore the env var and
    // pin every deployment to zh-CN.
    RELAY_DEFAULT_LOCALE: env.RELAY_DEFAULT_LOCALE,
    OPENAI_KEYS: env.OPENAI_KEYS,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    ANTHROPIC_KEYS: env.ANTHROPIC_KEYS,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    VERCEL_PROTECTION_BYPASS: env.VERCEL_PROTECTION_BYPASS,
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
        `Minimum required: RELAY_AUTH, RELAY_PUBLIC_URL.\n` +
        `Note: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are auto-injected\n` +
        `by the Upstash for Redis Vercel Marketplace after you install it on the project.\n` +
        `Without them, the app starts but all data routes fail; /healthz reports the state.\n` +
 +
        `See .env.example for the full list.`,
    );
  }

  // Transport policy: in production the public origin is what end users paste
  // into their API clients, so a plaintext http:// public origin would leak
  // session cookies and API keys onto the network. We still allow http for
  // loopback / private-network hosts, which is how self-hosted installs (and
  // the test suite) legitimately run behind a local reverse proxy or on a LAN.
  if (
    isProd &&
    !result.data.RELAY_PUBLIC_URL.startsWith("https://") &&
    !isLocalOrPrivateUrl(result.data.RELAY_PUBLIC_URL)
  ) {
    throw new Error(
      `[relayab] Invalid configuration. Fix the following env vars:\n` +
        `  - RELAY_PUBLIC_URL: must use https:// in production ` +
        `(got "${result.data.RELAY_PUBLIC_URL}").\n\n` +
        `Set RELAY_PUBLIC_URL to the public https origin of this deployment, ` +
        `e.g. https://relay.example.com.`,
    );
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/**
 * True when the URL points at a loopback or private-network host, where
 * plaintext http carries no additional exposure beyond the operator's own
 * machine or LAN.
 */
function isLocalOrPrivateUrl(raw: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  // IPv4 loopback (127.0.0.0/8) and RFC1918 ranges.
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  // IPv6 unique-local (fc00::/7).
  if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
  // Common internal suffixes.
  if (/\.(local|internal|lan|home|test)$/.test(hostname)) return true;
  return false;
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
 * The public-facing base URL of this instance.
 *
 * Surfaced to logged-in users via `/api/config` so the docs page can
 * hand them a copy-pasteable endpoint to plug into their OpenAI /
 * Anthropic-compatible clients.
 *
 * No trailing slash.
 */
export function getPublicUrl(): string {
  const cfg = loadConfig();
  return cfg.RELAY_PUBLIC_URL.replace(/\/$/, "");
}

/**
 * Resolve a URL relative to the public base URL. Useful for handing
 * users copy-pasteable endpoints like `${publicUrl()}/v1`.
 */
export function publicUrl(path: string): string {
  const base = getPublicUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}
