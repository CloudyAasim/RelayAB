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
 * - Returns early for static / public assets.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  applyCorsHeaders,
  corsHeaders,
  corsRequestInfo,
  isCorsPathname,
} from "@/lib/http/cors";

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

export function middleware(request: NextRequest) {
  const url = request.nextUrl;
  const cleanPath = cleanDoubleV1Path(url.pathname);

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
    const response = NextResponse.rewrite(rewritten);
    if (cors) applyCorsHeaders(response.headers, cors);
    return response;
  }

  const bypass = process.env.VERCEL_PROTECTION_BYPASS;
  if (!bypass) {
    const response = NextResponse.next();
    if (cors) applyCorsHeaders(response.headers, cors);
    return response;
  }

  // Forward the bypass header on every request so server-internal
  // fetches to api.vercel.com don't get blocked.
  const requestHeaders = new Headers(request.headers);
  if (!requestHeaders.has("x-vercel-protection-bypass")) {
    requestHeaders.set("x-vercel-protection-bypass", bypass);
  }
  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  if (cors) applyCorsHeaders(response.headers, cors);
  return response;
}

export const config = {
  // Skip static assets and Next internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|svg|ico|webp|woff2?)$).*)",
  ],
};
