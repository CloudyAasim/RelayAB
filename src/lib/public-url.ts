/**
 * src/lib/public-url.ts
 *
 * Request-aware resolution of the deployment's public base URL.
 *
 * Resolution order:
 *   1. Database settings (admin configurable) - highest priority
 *   2. RELAY_PUBLIC_URL - explicit override (custom domain / reverse proxy)
 *   3. VERCEL_URL - injected by Vercel
 *   4. request headers - x-forwarded-proto + x-forwarded-host
 *   5. http://localhost:3000 - last-resort local default
 *
 * Server-only: imports `next/headers`. Never call from a client component.
 */
import { headers } from "next/headers";
import { getPublicUrl as getConfigPublicUrl } from "./config";

// Cache the settings URL to avoid repeated Redis calls
let cachedSettingsUrl: string | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60000; // 1 minute

/**
 * Get public URL from database settings (admin configurable).
 * This is cached for performance.
 */
async function getSettingsPublicUrl(): Promise<string | null> {
  try {
    // Check cache first
    if (cachedSettingsUrl !== null && Date.now() - settingsCacheTime < SETTINGS_CACHE_TTL) {
      return cachedSettingsUrl;
    }
    
    const { getSettings } = await import("./db/settings");
    const settings = await getSettings();
    
    if (settings.publicUrl) {
      cachedSettingsUrl = settings.publicUrl;
      settingsCacheTime = Date.now();
      return settings.publicUrl;
    }
    
    cachedSettingsUrl = null;
    return null;
  } catch {
    return null;
  }
}

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
 * Resolution order:
 *   1. Database settings (admin configurable)
 *   2. RELAY_PUBLIC_URL environment variable
 *   3. Vercel automatic URL
 *   4. Request headers
 *   5. localhost fallback
 */
export async function resolvePublicUrl(): Promise<string> {
  // Priority 1: Check database settings (admin configurable)
  const settingsUrl = await getSettingsPublicUrl();
  if (settingsUrl) {
    return settingsUrl.replace(/\/+$/, "");
  }

  // Priority 2: Check environment variable
  if (envProvidedUrl()) {
    try {
      return getConfigPublicUrl();
    } catch {
      // Fall through to header-based resolution
    }
  }

  // Priority 3 & 4: Try request headers
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

  // Priority 5: Fallback to config or localhost
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
