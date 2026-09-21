/**
 * src/middleware.ts
 *
 * Edge middleware for global request handling.
 *
 * - Injects `x-vercel-protection-bypass` when the env secret is set,
 *   so server-side SDK calls can transparently bypass Vercel's
 *   Deployment Protection (the bypass header is otherwise needed
 *   by every SDK client).
 * - Returns early for static / public assets.
 */
import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const bypass = process.env.VERCEL_PROTECTION_BYPASS;
  if (!bypass) {
    return NextResponse.next();
  }

  // Forward the bypass header on every request so server-internal
  // fetches to api.vercel.com don't get blocked.
  const requestHeaders = new Headers(request.headers);
  if (!requestHeaders.has("x-vercel-protection-bypass")) {
    requestHeaders.set("x-vercel-protection-bypass", bypass);
  }
  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  // Skip static assets and Next internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|svg|ico|webp|woff2?)$).*)",
  ],
};
