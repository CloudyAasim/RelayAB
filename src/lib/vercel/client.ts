/**
 * src/lib/vercel/client.ts
 *
 * Thin wrapper around `@vercel/sdk` that toggles the `baseURL` based on
 * the validated config. The Vercel SDK is the official client for the
 * Vercel REST API; we use it for:
 *
 *   - createApiKey / listApiKeys / updateApiKey (provider key management)
 *   - getSpending / getUsage (when the user wants Vercel-side budgets)
 *
 * In production (NODE_ENV=production or EMULATE_VERCEL_LOCAL=0), the
 * base URL is `https://api.vercel.com`. In local dev with the embedded
 * emulator enabled, we point at our own catch-all:
 *   http://localhost:${PORT}/api/_emu/vercel
 *
 * Auth token comes from `VERCEL_TOKEN` env var (admin-level).
 */
import { Vercel } from "@vercel/sdk";
import { isEmulatorEnabled } from "../config";

// ---------------------------------------------------------------------------
// baseURL computation
// ---------------------------------------------------------------------------

/**
 * Compute the base URL the Vercel SDK should talk to.
 *
 * In production: `https://api.vercel.com`
 * In dev with emulator: `http://localhost:3000/api/_emu/vercel`
 *
 * Exposed for tests and for the middleware (which injects the bypass
 * header) so the two paths stay in sync.
 */
export function vercelBaseUrl(opts: {
  isEmulator: boolean;
  port?: number;
}): string {
  if (opts.isEmulator) {
    return `http://localhost:${opts.port ?? 3000}/api/_emu/vercel`;
  }
  return "https://api.vercel.com";
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

let cachedClient: Vercel | null = null;
let cachedToken: string | null = null;

/**
 * Get a shared Vercel SDK client.
 *
 * Token is read from `VERCEL_TOKEN`. In test environments the loader
 * may not provide one; callers should fall back to mocks.
 *
 * Caching strategy: we cache by token. Calling code that needs a fresh
 * client (e.g. after token rotation) should call `__resetVercelClientForTest`.
 */
export function getVercelClient(token?: string): Vercel {
  const tk = token ?? process.env.VERCEL_TOKEN ?? "";
  if (cachedClient && cachedToken === tk) return cachedClient;

  cachedClient = new Vercel({
    bearerToken: tk,
    serverURL: vercelBaseUrl({ isEmulator: isEmulatorEnabled() }),
  });
  cachedToken = tk;
  return cachedClient;
}

/** Test-only: clear the cached client so the next call rebuilds it. */
export function __resetVercelClientForTest(): void {
  cachedClient = null;
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// High-level wrappers (used by admin API routes)
// ---------------------------------------------------------------------------

/**
 * Wrap a Vercel SDK call with the deployment-protection bypass header.
 *
 * The bypass is needed when the user's Vercel project has
 * "Deployment Protection" enabled: incoming requests get intercepted
 * by Vercel's auth wall unless `x-vercel-protection-bypass` matches.
 *
 * We forward the header transparently for SDK methods that accept
 * `headers` (most don't, so we fall back to documenting the limitation).
 */
export function bypassHeaders(): Record<string, string> | undefined {
  const secret = process.env.VERCEL_PROTECTION_BYPASS;
  if (!secret) return undefined;
  return { "x-vercel-protection-bypass": secret };
}


