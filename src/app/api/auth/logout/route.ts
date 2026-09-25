/**
 * app/api/auth/logout/route.ts
 *
 * POST /api/auth/logout — clears the session cookie.
 */
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { destroySession } from "@/lib/auth/session";

export async function POST(): Promise<Response> {
  await destroySession();
  // Evict the client Router Cache for the authenticated tree so the previous
  // user's pages cannot be served from cache after logout.
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, data: { loggedOut: true } });
}
