/**
 * src/lib/http/cors.ts
 *
 * Cross-Origin Resource Sharing for the public relay surface.
 *
 * Why this exists:
 *   ONLYOFFICE's AI plugin (and other browser-hosted clients) call the relay
 *   directly from the browser via `fetch`. The plugin window lives on the
 *   Document Server origin (e.g. https://docs.example.com) while the relay is
 *   served from https://api.aasim.l.cd, so every call is cross-origin.
 *
 *   `GET /v1/models` — the request the plugin uses to populate the model
 *   dropdown — is issued as a simple CORS request with `Authorization`, and
 *   `POST /v1/chat/completions` triggers a preflight. Without
 *   `Access-Control-Allow-Origin` the browser discards the response and the
 *   plugin reports that it cannot load any model, even though `curl` against
 *   the same endpoint succeeds.
 *
 * Scope: only the public OpenAI/Anthropic compatible prefixes are exposed.
 * Cookie-authenticated surfaces (`/api/admin/*`, `/api/user/*`, `/api/auth/*`,
 * app pages) deliberately get no CORS headers, so a hostile page cannot read
 * them with the visitor's session.
 *
 * No credentials are allowed: the public API authenticates with a bearer key
 * supplied by the caller, never with an ambient cookie.
 */

/** Path prefixes reachable from a browser document. */
const CORS_PATH_PREFIXES = ["/v1", "/api/v1", "/anthropic", "/api/anthropic"] as const;

/** Headers a browser client may send. Echoed back when the browser asks. */
const DEFAULT_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
].join(", ");

/** Methods the public relay implements. */
const ALLOWED_METHODS = "GET, POST, OPTIONS";

/** How long a browser may cache the preflight result (seconds). */
const MAX_AGE = "86400";

export interface CorsRequestInfo {
  /** Value of the `Origin` request header, if any. */
  origin?: string | null;
  /** Value of the `Access-Control-Request-Headers` preflight header, if any. */
  requestedHeaders?: string | null;
}

/**
 * True when `pathname` belongs to the public, browser-reachable API surface.
 *
 * Matching is done on whole path segments so that a future `/v1beta` route is
 * not accidentally exposed.
 */
export function isCorsPathname(pathname: string): boolean {
  return CORS_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Build the CORS response headers for one request.
 *
 * The origin is echoed when present (with `Vary: Origin` so caches don't mix
 * responses between origins); otherwise `*` is used so tools that omit the
 * header still see a usable response.
 */
export function corsHeaders(info: CorsRequestInfo): Record<string, string> {
  const origin = typeof info.origin === "string" ? info.origin.trim() : "";
  const requested =
    typeof info.requestedHeaders === "string" && info.requestedHeaders.trim().length > 0
      ? info.requestedHeaders.trim()
      : DEFAULT_ALLOWED_HEADERS;

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin.length > 0 ? origin : "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": requested,
    "Access-Control-Max-Age": MAX_AGE,
  };

  if (origin.length > 0) {
    headers["Vary"] = "Origin";
  }

  return headers;
}

/**
 * Merge CORS headers into an existing `Headers` instance.
 *
 * `Vary` is appended rather than replaced so Next.js' own cache-key values
 * survive.
 */
export function applyCorsHeaders(target: Headers, info: CorsRequestInfo): void {
  const extra = corsHeaders(info);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === "vary") {
      const existing = target.get("Vary");
      if (!existing) {
        target.set("Vary", value);
      } else if (!existing.split(",").map((v) => v.trim().toLowerCase()).includes(value.toLowerCase())) {
        target.set("Vary", `${existing}, ${value}`);
      }
      continue;
    }
    target.set(key, value);
  }
}

/** Extract the CORS-relevant bits from a request-like object. */
export function corsRequestInfo(headers: Headers): CorsRequestInfo {
  return {
    origin: headers.get("origin"),
    requestedHeaders: headers.get("access-control-request-headers"),
  };
}

/** True when `method` is a CORS preflight. */
export function isPreflight(method: string, headers: Headers): boolean {
  return method.toUpperCase() === "OPTIONS" && headers.get("origin") !== null;
}
