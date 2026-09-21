/**
 * app/api/auth/me/route.ts
 *
 * GET /api/auth/me — returns the currently authenticated user, or 401.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { toPublicUser } from "@/lib/db/types";


export async function GET(): Promise<Response> {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

  // Re-fetch from DB to pick up any updates since session was created.
  const user = await getUserById(sessionUser.id);
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "User no longer exists" } },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, data: { user: toPublicUser(user) } });
}
