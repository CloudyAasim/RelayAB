/**
 * app/api/admin/users/[id]/toggle/route.ts
 *
 * POST /api/admin/users/[id]/toggle
 * Body: { disabled: boolean }
 *
 * Dedicated endpoint for enabling/disabling a user.
 * Returns the updated user on success.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserById, updateUser } from "@/lib/db/users";
import { toPublicUser } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const BodySchema = z.object({
  disabled: z.boolean(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  const existing = await getUserById(id);
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }

  // Prevent admin from locking themselves out
  if (id === me.id && parsed.data.disabled === true) {
    return NextResponse.json(
      { ok: false, error: { code: "self_disable", message: "Cannot disable your own account" } },
      { status: 400 },
    );
  }

  const updated = await updateUser(id, { disabled: parsed.data.disabled });
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, data: { user: toPublicUser(updated) } });
}
