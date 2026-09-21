/**
 * app/api/auth/logout/route.ts
 *
 * POST /api/auth/logout — clears the session cookie.
 */
import { NextResponse } from "next/server";
import { destroySession } from "@/lib/auth/session";

export async function POST(): Promise<Response> {
  await destroySession();
  return NextResponse.json({ ok: true, data: { loggedOut: true } });
}
