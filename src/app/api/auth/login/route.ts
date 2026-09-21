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

  // A fresh deployment has no admin yet — create it from RELAY_AUTH before
  // the first login attempt so the documented bootstrap flow works.
  try {
    await ensureBootstrapped();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bootstrap_failed",
          message: err instanceof Error ? err.message : "Bootstrap failed",
        },
      },
      { status: 500 },
    );
  }

  const user = await verifyUserCredentials(parsed.data.username, parsed.data.password);
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_credentials", message: "Invalid username or password" } },
      { status: 401 },
    );
  }

  const session = await getSession();
  session.userId = user.id;
  session.username = user.username;
  session.role = user.role;
  session.iat = Math.floor(Date.now() / 1000);
  await session.save();
  await touchLastLogin(user.id);

  return NextResponse.json({
    ok: true,
    data: { user: toPublicUser(user) },
  });
}
