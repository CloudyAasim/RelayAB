/**
 * src/lib/public-url.ts
 *
 * Request-aware resolution of the deployment's public base URL.
 *
 * Resolution order:
 *   1. RELAY_PUBLIC_URL  — explicit override (custom domain / reverse proxy)
 *   2. VERCEL_URL        — injected by Vercel; no configuration needed
 *   3. request headers   — x-forwarded-proto + x-forwarded-host, then host
 *   4. http://localhost:3000 — last-resort local default
 *
 * Server-only: imports `next/headers`. Never call from a client component.
 */
import { headers } from "next/headers";
import { getPublicUrl as getConfigPublicUrl } from "./config";

/**
 * Get public URL from config without throwing.
 * Returns a fallback value if config is not available.
 */
function getPublicUrlSafe(): string {
  try {
    return getConfigPublicUrl();
  } catch {
    return "http://localhost:3000";
  }
}

/** True when an explicit override or VERCEL_URL already answered the question. */
function envProvidedUrl(): boolean {
  try {
    const cfg = getPublicUrlSafe();
    return cfg !== "http://localhost:3000";
  } catch {
    return false;
  }
}

/**
 * Resolve the public base URL for the current request.
 *
 * Never throws: a landing or docs page must still render if configuration is
 * partly missing, so every failure path degrades to a usable string.
 */
export async function resolvePublicUrl(): Promise<string> {
  if (envProvidedUrl()) {
    try {
      return getConfigPublicUrl();
    } catch {
      // Fall through to header-based resolution
    }
  }

  try {
    const h = await headers();

    const host =
      h.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      h.get("host")?.trim();

    if (host) {
      const proto =
        h.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      return `${proto}://${host}`.replace(/\/+$/, "");
    }
  } catch {
    // Outside a request scope (e.g. build-time prerender) — fall through.
  }

  return getPublicUrlSafe();
}

/**
 * `resolvePublicUrl()` plus a path, e.g. the OpenAI-compatible base URL.
 */
export async function resolvePublicPath(path: string): Promise<string> {
  const base = await resolvePublicUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}
