/**
 * src/lib/auth/session.ts
 *
 * Session management using iron-session 8.
 *
 * Iron-session encrypts the session payload (AES-256-GCM under the hood)
 * and stores it as a single HttpOnly cookie. No server-side store is
 * required; revocation is done by overwriting the cookie.
 *
 * Usage in a Next.js route handler (App Router):
 *
 *     import { cookies } from "next/headers";
 *     import { getSession, destroySession } from "@/lib/auth/session";
 *
 *     export async function POST(req: Request) {
 *       const session = await getSession();
 *       session.userId = "01J...";
 *       session.role = "admin";
 *       await session.save();
 *       ...
 *     }
 *
 * The cookie name is `relay_session`. All cookies set in production have
 * `Secure` and `SameSite=Lax`. In development we relax `Secure` so the
 * cookie works on http://localhost.
 */
import { getIronSession, type IronSession, type SessionOptions } from "iron-session";
import { cache } from "react";
import { cookies } from "next/headers";
import { isProduction, getSessionPassword } from "../config";
import { ensureBootstrapped } from "../db/bootstrap";
import { getUserById } from "../db/users";
import type { Role } from "../db/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionData {
  userId?: string;
  username?: string;
  /** Cached so the shell can render it without an extra Redis read. */
  displayName?: string;
  role?: Role;
  /** Unix seconds when the session was created. */
  iat?: number;
}

export const SESSION_COOKIE_NAME = "relay_session";

/** Default session lifetime: 7 days. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Build SessionOptions from the validated config.
 * Centralized so route handlers / pages don't duplicate the logic.
 */
export function getSessionOptions(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE_NAME,
    password: getSessionPassword(),
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction(),
      sameSite: "lax",
      path: "/",
      // Set maxAge slightly shorter than ttl so the cookie always
      // expires before the session payload itself.
      maxAge: SESSION_TTL_SECONDS - 60,
    },
  };
}

// ---------------------------------------------------------------------------
// Session retrieval (App Router)
// ---------------------------------------------------------------------------

/**
 * Get the current session from the Next.js App Router cookie store.
 *
 * IMPORTANT: must be called from a route handler, server action, or
 * server component. Will throw in client code because `next/headers`
 * cookies() is server-only.
 */
export async function getSession(): Promise<IronSession<SessionData>> {
  const store = await cookies();
  return getIronSession<SessionData>(store, getSessionOptions());
}

/**
 * Destroy the current session by clearing the cookie.
 * After this call, the client should treat the user as logged out.
 */
export async function destroySession(): Promise<void> {
  const session = await getSession();
  session.destroy();
}

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

export interface AuthedUser {
  id: string;
  username: string;
  displayName?: string;
  role: Role;
}

export type SessionRejection = "user_not_found" | "user_disabled";

export interface CurrentUserLookup {
  user: AuthedUser | null;
  /**
   * Set when a session cookie was present and decryptable, but the account
   * behind it is gone or has been disabled. Lets API routes answer with an
   * actionable 403 instead of a bare "please sign in" 401.
   */
  rejection?: SessionRejection;
}

/**
 * Resolve the caller *and* the reason a session was refused.
 *
 * Callers that require auth should redirect or 401 themselves.
 * We don't throw here because the response shape depends on context
 * (page vs API route).
 */
async function lookupCurrentUserUncached(): Promise<CurrentUserLookup> {
  // Read the session first: `cookies()` is what makes the enclosing server
  // component dynamic. Doing this before the bootstrap keeps `next build` from
  // running bootstrap while prerendering (build machines have no env vars and
  // no Redis).
  const session = await getSession();

  // First request on a fresh instance creates the admin + seeds providers.
  // Memoized, so warm instances pay nothing after the first call.
  await ensureBootstrapped();

  if (!session.userId || !session.username || !session.role) {
    return { user: null };
  }

  // The cookie only *caches* identity — it cannot be revoked server-side, so a
  // stale cookie would otherwise keep working until it expires. Re-read the
  // record so that disabling or deleting an account takes effect on the very
  // next request instead of leaving the user a fully working dashboard.
  const user = await getUserById(session.userId);
  if (!user) return { user: null, rejection: "user_not_found" };
  if (user.disabled) return { user: null, rejection: "user_disabled" };

  return {
    user: {
      id: user.id,
      // Prefer the stored record over the cookie: an admin may have renamed the
      // account since the cookie was minted.
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

/**
 * Request-scoped memoized lookup.
 *
 * A single page render asks for the current user several times — the segment
 * layout (auth gate + shell), the page itself (defence-in-depth role check),
 * and any helper that needs the id. Without memoization each call re-read the
 * user hash from Redis, which on a REST-backed Redis is a full round trip per
 * call. `cache()` collapses them into one read per request.
 *
 * Outside a React render (route handlers, scripts, tests) `cache()` simply
 * calls through, so this stays correct everywhere.
 */
export const lookupCurrentUser = cache(lookupCurrentUserUncached);

/**
 * Return the currently authenticated user, or null when the caller must be
 * treated as signed out — no session, deleted account, or disabled account.
 */
export async function getCurrentUser(): Promise<AuthedUser | null> {
  return (await lookupCurrentUser()).user;
}

/**
 * Build a JSON Response for "unauthenticated" cases.
 * Caller decides the status (401 for API, 302 for pages).
 */
export function unauthenticatedResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "unauthenticated", message: "Login required" },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Build a JSON Response for "forbidden" (logged in but lacking permission).
 */
export function forbiddenResponse(message = "Forbidden"): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "forbidden", message },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Sentinel thrown by guards to signal the response is already built.
 * Route handlers can catch and re-throw.
 */
export class AuthGuardError extends Error {
  constructor(public readonly response: Response) {
    super("auth-guard");
    this.name = "AuthGuardError";
  }
}

/**
 * Throws AuthGuardError(unauth) if no user.
 * Throws AuthGuardError(forbidden) if user is not admin.
 *
 * Use in API route handlers like:
 *
 *     try {
 *       await requireAdmin();
 *     } catch (e) {
 *       if (e instanceof AuthGuardError) return e.response;
 *       throw e;
 *     }
 */
export async function requireUser(): Promise<AuthedUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthGuardError(unauthenticatedResponse());
  return user;
}

export async function requireAdmin(): Promise<AuthedUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new AuthGuardError(forbiddenResponse("Admin role required"));
  }
  return user;
}

// ---------------------------------------------------------------------------
// Cookie option type (replaces the internal one from iron-session)
// ---------------------------------------------------------------------------

interface ResponseCookie {
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
  expires?: Date | number;
  domain?: string;
  priority?: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Manual cookie store (for tests / non-Next runtimes)
// ---------------------------------------------------------------------------



/**
 * In-memory cookie store for unit tests. Implements only the subset of
 * the Next.js CookieStore that iron-session uses.
 */
export class InMemoryCookieStore {
  private jar = new Map<string, { value: string; opts?: Partial<ResponseCookie> }>();

  get(name: string): { name: string; value: string } | undefined {
    const c = this.jar.get(name);
    if (!c) return undefined;
    return { name, value: c.value };
  }

  set(name: string, value: string, opts?: Partial<ResponseCookie>): void;
  set(opts: ResponseCookie): void;
  set(arg1: string | ResponseCookie, value?: string, opts?: Partial<ResponseCookie>): void {
    if (typeof arg1 === "string") {
      this.jar.set(arg1, { value: value ?? "", opts });
    } else {
      this.jar.set(arg1.name, { value: arg1.value, opts: arg1 });
    }
  }

  /** Test helper: clear all cookies. */
  clear(): void {
    this.jar.clear();
  }

  /** Test helper: list all cookie entries with options. */
  entries(): Array<{ name: string; value: string; opts?: Partial<ResponseCookie> }> {
    return Array.from(this.jar, ([name, { value, opts }]) => ({ name, value, opts }));
  }
}

/**
 * Get a session backed by an explicit cookie store.
 * Useful for tests and for non-Next runtimes (scripts, edge functions).
 */
export async function getSessionFromStore<T extends object = SessionData>(
  store: InMemoryCookieStore,
): Promise<IronSession<T>> {
  return getIronSession<T>(store as any, getSessionOptions());
}
