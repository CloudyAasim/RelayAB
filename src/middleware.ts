/**
 * src/middleware.ts
 *
 * Edge middleware for global request handling.
 *
 * - Normalises double-/v1/ paths produced by OnlyOffice's OpenAI template
 *   when the user configures a base URL that already ends in /v1
 *   (e.g. OnlyOffice calls /v1/v1/models → rewritten to /v1/models).
 * - Answers CORS preflights and stamps CORS response headers on the public
 *   OpenAI/Anthropic surface, so browser-hosted clients (the ONLYOFFICE AI
 *   plugin, the OpenAI SDK in a web app, ...) can read the responses.
 * - Injects `x-vercel-protection-bypass` when the env secret is set,
 *   so server-side SDK calls can transparently bypass Vercel's
 *   Deployment Protection (the bypass header is otherwise needed
 *   by every SDK client).
 * - Remembers the usage screens' last-used view (range/scope/metric/…)
 *   in a cookie and replays it when the URL carries no view params.
 * - Returns early for static / public assets.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  applyCorsHeaders,
  corsHeaders,
  corsRequestInfo,
  isCorsPathname,
} from "@/lib/http/cors";
import { usageViewCookieName, usageViewFromParams } from "@/lib/usage/view-prefs";

/**
 * Strip a duplicate /v1/ segment from the start of a URL path.
 *
 * OnlyOffice's OpenAI template builds the target URL by appending an
 * OpenAI-style endpoint (e.g. /v1/models) to the user-configured base.
 * If the base already ends in /v1 (a common user mistake), the resulting
 * path is /v1/v1/... which has no handler and returns 404.
 *
 * This rewrite is safe and specific — it only fires when the path
 * literally begins with the exact two-segment sequence /v1/v1/.
 */
function cleanDoubleV1Path(path: string): string {
  if (path.startsWith("/v1/v1/") || path === "/v1/v1") {
    return path.replace(/^\/v1\/v1(\/.*)?$/, "/v1$1");
  }
  return path;
}

/**
 * Cookie-authenticated API surfaces. Responses here are per-session and must
 * never be stored by a shared/proxy cache, so we force `Cache-Control: no-store`
 * as defence in depth (the handlers also read cookies, which makes them
 * dynamic, but an explicit header is cheap and unambiguous).
 */
const NO_STORE_API_PREFIXES = ["/api/auth", "/api/admin", "/api/user"] as const;

function isNoStoreApiPath(pathname: string): boolean {
  return NO_STORE_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Apply CORS (public surface), no-store (session surface) and view cookies. */
function stampResponse(
  response: NextResponse,
  pathname: string,
  cors: ReturnType<typeof corsRequestInfo> | null,
  viewCookie?: { name: string; value: string } | null,
): NextResponse {
  if (cors) applyCorsHeaders(response.headers, cors);
  if (isNoStoreApiPath(pathname)) {
    response.headers.set("Cache-Control", "no-store");
  }
  if (viewCookie) {
    response.cookies.set(viewCookie.name, viewCookie.value, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

export function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const cleanPath = cleanDoubleV1Path(url.pathname);

  // Usage screens remember the last-used view (range/scope/metric/group/…).
  // Persist it when the URL carries one; replay it when the URL carries none.
  let viewCookie: { name: string; value: string } | null = null;
  const viewCookieName =
    request.method === "GET" ? usageViewCookieName(cleanPath) : null;
  if (viewCookieName) {
    // `?reset=1` is the escape hatch: forget the saved view and land on the
    // bare URL, which renders the defaults.
    if (url.searchParams.has("reset")) {
      const target = url.clone();
      target.search = "";
      const response = NextResponse.redirect(target);
      response.cookies.delete(viewCookieName);
      return response;
    }
    const current = usageViewFromParams(url.searchParams);
    if (current) {
      viewCookie = { name: viewCookieName, value: current };
    } else {
      const stored = request.cookies.get(viewCookieName)?.value;
      const replay = stored
        ? usageViewFromParams(new URLSearchParams(stored))
        : null;
      if (replay) {
        const target = url.clone();
        target.search = `?${replay}`;
        return NextResponse.redirect(target);
      }
    }
  }

  // A browser client (OnlyOffice plugin, dashboard, SDK in a web app) always
  // sends an Origin header; without CORS headers the response is unusable
  // there even when the request itself succeeds.
  const cors = isCorsPathname(cleanPath) ? corsRequestInfo(request.headers) : null;

  if (cors && request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(cors) });
  }

  if (cleanPath !== url.pathname) {
    // Rewrite the path so the Next.js router dispatches to the correct handler.
    const rewritten = request.nextUrl.clone();
    rewritten.pathname = cleanPath;
    return stampResponse(NextResponse.rewrite(rewritten), cleanPath, cors, viewCookie);
  }

  const bypass = process.env.VERCEL_PROTECTION_BYPASS;
  if (!bypass) {
    return stampResponse(NextResponse.next(), cleanPath, cors, viewCookie);
  }

  // Forward the bypass header on every request so server-internal
  // fetches to api.vercel.com don't get blocked.
  const requestHeaders = new Headers(request.headers);
  if (!requestHeaders.has("x-vercel-protection-bypass")) {
    requestHeaders.set("x-vercel-protection-bypass", bypass);
  }
  return stampResponse(
    NextResponse.next({ request: { headers: requestHeaders } }),
    cleanPath,
    cors,
    viewCookie,
  );
}

export const config = {
  // Skip static assets and Next internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|svg|ico|webp|woff2?)$).*)",
  ],
};
