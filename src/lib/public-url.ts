/**
 * src/lib/public-url.ts
 *
 * Request-aware resolution of the deployment's public base URL.
 *
 * Why this exists rather than one env var: the address users should paste
 * into their clients is almost always the address they just reached us on.
 * Asking an operator to repeat it back as a required environment variable is
 * busywork that also becomes wrong the moment they attach a custom domain.
 *
 * Resolution order:
 *   1. RELAY_PUBLIC_URL  — explicit override (custom domain / reverse proxy)
 *   2. VERCEL_URL        — injected by Vercel; no configuration needed
 *   3. request headers   — x-forwarded-proto + x-forwarded-host, then host
 *   4. http://localhost:3000 — last-resort local default
 *
 * Steps 1–2 are env-only, so this costs one `headers()` read in the common
 * self-hosted case and nothing at all on Vercel.
 *
 * Server-only: imports `next/headers`. Never call from a client component.
 */
import { headers } from "next/headers";
import { getPublicUrl } from "./config";

/** True when an explicit override or VERCEL_URL already answered the question. */
function envProvidedUrl(): boolean {
  try {
    const cfg = getPublicUrl();
    // getPublicUrl() falls back to localhost; if it returned anything else,
    // either RELAY_PUBLIC_URL or VERCEL_URL supplied it.
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
  if (envProvidedUrl()) return getPublicUrl();

  try {
    const h = await headers();

    // Behind a proxy (Vercel, nginx, Cloudflare) the original scheme and host
    // live in x-forwarded-*; `host` alone would lose the scheme.
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

  return getPublicUrl();
}

/**
 * `resolvePublicUrl()` plus a path, e.g. the OpenAI-compatible base URL.
 */
export async function resolvePublicPath(path: string): Promise<string> {
  const base = await resolvePublicUrl();
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}
