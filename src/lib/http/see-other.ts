/**
 * src/lib/http/see-other.ts
 *
 * 303 See Other responses for browser-driven (plain HTML <form>) mutations.
 */
import { NextResponse } from "next/server";

/**
 * Build a `303 See Other` response that redirects to `path` on the SAME
 * origin the browser is already using.
 *
 * Always prefer this over `NextResponse.redirect(new URL(path, req.url))`.
 * `req.url` inside a serverless function is whatever host the runtime
 * reconstructed for that request — behind a proxy / deployment-protection
 * layer that is not guaranteed to be the host the browser typed (a custom
 * domain, a preview URL alias, or an internal hostname). Bouncing the user to
 * a different host silently drops the session cookie, which scopes to the
 * origin, and the next page load 302s to /login — i.e. the mutation looks like
 * it "did nothing".
 *
 * A relative `Location` header (RFC 9110 §10.2.2 allows relative references)
 * is resolved by the browser against the request URL, so the redirect always
 * stays on the origin the user is already on.
 */
export function seeOther(path: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: path.startsWith("/") ? path : `/${path}`,
      "Cache-Control": "no-store",
    },
  });
}
