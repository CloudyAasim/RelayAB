/**
 * app/api/admin/announcements/[id]/route.ts
 *
 *   GET     → one row
 *   PATCH   → edit it (enable, pin, retitle, move the window)
 *   DELETE  → remove it
 *
 * PATCH is a merge, not a replace: `{enabled:false}` is the switch in the list,
 * and it must not require the caller to resend the title and body it is not
 * touching.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  ANNOUNCEMENT_LEVELS,
  AnnouncementValidationError,
  deleteAnnouncement,
  getAnnouncementById,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  updateAnnouncement,
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

const InstantSchema = z
  .string()
  .max(40)
  .refine((v) => v.trim() === "" || !Number.isNaN(Date.parse(v)), {
    message: "Not a valid date and time",
  })
  .nullable();

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    body: z.string().trim().min(1).max(MAX_BODY_LENGTH).optional(),
    level: z.enum(ANNOUNCEMENT_LEVELS).optional(),
    pinned: z.boolean().optional(),
    enabled: z.boolean().optional(),
    startsAt: InstantSchema.optional(),
    endsAt: InstantSchema.optional(),
  })
  .strict();

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;
  const announcement = await getAnnouncementById(id);
  if (!announcement) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Announcement not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { announcement } });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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
  const parsed = PatchSchema.safeParse(body);
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

  const { id } = await context.params;
  try {
    const announcement = await updateAnnouncement(id, parsed.data);
    if (!announcement) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "Announcement not found" } },
        { status: 404 },
      );
    }
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

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;
  const removed = await deleteAnnouncement(id);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Announcement not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedAnnouncementId: id } });
}