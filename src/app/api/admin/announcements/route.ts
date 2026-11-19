/**
 * app/api/admin/announcements/route.ts
 *
 *   GET  /api/admin/announcements   → every row, whatever its state
 *   POST /api/admin/announcements   → write one
 *
 * Admin-only, and the *whole* list rather than the active one: an announcement
 * that has not started yet, or has finished, is invisible to a reader but is
 * exactly what an admin needs to see to know what they scheduled.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  AnnouncementValidationError,
  ANNOUNCEMENT_LEVELS,
  createAnnouncement,
  listAnnouncements,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/db/announcements";

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<NextResponse | null> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  return null;
}

/**
 * A timestamp as the form submits it.
 *
 * `datetime-local` sends `2026-11-18T20:49` with no zone, and the repository
 * resolves that against the server's clock. An empty string is a deliberate
 * "no bound on this side", so it is accepted and means null.
 */
const InstantSchema = z
  .string()
  .max(40)
  .refine((v) => v.trim() === "" || !Number.isNaN(Date.parse(v)), {
    message: "Not a valid date and time",
  })
  .nullable();

const CreateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    body: z.string().trim().min(1).max(MAX_BODY_LENGTH),
    level: z.enum(ANNOUNCEMENT_LEVELS).optional(),
    pinned: z.boolean().optional(),
    enabled: z.boolean().optional(),
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema.optional(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  return NextResponse.json({ ok: true, data: { announcements: await listAnnouncements() } });
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: parsed.error.issues.map((i) => i.message).join("; ") || "invalid body",
        },
      },
      { status: 400 },
    );
  }

  try {
    const announcement = await createAnnouncement(parsed.data);
    return NextResponse.json({ ok: true, data: { announcement } });
  } catch (err) {
    if (err instanceof AnnouncementValidationError) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: err.issues.join("; ") } },
        { status: 400 },
      );
    }
    throw err;
  }
}