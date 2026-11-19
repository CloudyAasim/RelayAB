/**
 * app/api/announcements/route.ts
 *
 *   GET /api/announcements   → the notices a reader should see right now
 *
 * Read by **anyone**, signed in or not. That is deliberate: the public docs
 * page shows the same announcements, and an anonymous visitor deciding whether
 * to sign up is exactly who a maintenance notice is for.
 *
 * Only active rows leave here, already stripped by `toPublicAnnouncement` — the
 * `enabled` switch and anything else that is the operator's business stay in
 * the admin endpoint. Not cached: an announcement that says "the gateway is down
 * for ten minutes" is worthless once it is a minute stale.
 */
import { NextResponse } from "next/server";
import { listActiveAnnouncements, toPublicAnnouncement } from "@/lib/db/announcements";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const rows = await listActiveAnnouncements();
  return NextResponse.json({
    ok: true,
    data: { announcements: rows.map(toPublicAnnouncement) },
  });
}