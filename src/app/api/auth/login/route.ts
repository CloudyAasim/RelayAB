/**
 * app/api/auth/login/route.ts
 *
 * POST /api/auth/login
 * Body: { username: string, password: string }
 *
 * Returns the public user profile on success and sets the session cookie.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyUserCredentials, touchLastLogin } from "@/lib/db/users";
import { ensureBootstrapped } from "@/lib/db/bootstrap";
import { getSession } from "@/lib/auth/session";
import {
  checkLoginThrottle,
  recordLoginFailure,
  clearLoginFailures,
} from "@/lib/auth/login-throttle";
import { toPublicUser } from "@/lib/db/types";

const BodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "username and password required" } },
      { status: 400 },
    );
  }

  // Refuse further attempts once the caller has burned their failure budget.
  // Checked before bootstrap so a blocked client cannot keep hitting Redis
  // and bcrypt on every request.
  const throttle = await checkLoginThrottle(req.headers, parsed.data.username);
  if (throttle.limited) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: "Too many failed sign-in attempts. Please try again later.",
        },
      },
      { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
    );
  }

  // A fresh deployment has no admin yet — create it from RELAY_AUTH before
  // the first login attempt so the documented bootstrap flow works.
  try {
    await ensureBootstrapped();
  } catch (err) {
    // Log the detail server-side; never return internal error text (it can
    // include database URLs / driver messages) to an unauthenticated caller.
    console.error("[auth/login] bootstrap failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bootstrap_failed",
          message: "Server is not ready. Please try again shortly.",
        },
      },
      { status: 503 },
    );
  }

  const user = await verifyUserCredentials(parsed.data.username, parsed.data.password);
  if (!user) {
    await recordLoginFailure(req.headers, parsed.data.username);
    return NextResponse.json(
      { ok: false, error: { code: "invalid_credentials", message: "Invalid username or password" } },
      { status: 401 },
    );
  }

  // Successful sign-in clears the failure budget for this IP and username.
  await clearLoginFailures(req.headers, parsed.data.username);

  const session = await getSession();
  session.userId = user.id;
  session.username = user.username;
  session.displayName = user.displayName;
  session.role = user.role;
  session.iat = Math.floor(Date.now() / 1000);
  await session.save();
  await touchLastLogin(user.id);

  return NextResponse.json({
    ok: true,
    data: { user: toPublicUser(user) },
  });
}
