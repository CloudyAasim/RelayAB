/**
 * app/api/admin/users/[id]/route.ts
 *
 * PATCH  /api/admin/users/[id]  body: { displayName?, role?, quotaType?, quotaLimit?, quotaUsed?, maxActiveKeys?, allowedModels? }
 * DELETE /api/admin/users/[id]
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getUserById, updateUser, deleteUser } from "@/lib/db/users";
import { deleteApiKeysByUser } from "@/lib/db/keys";
import { toPublicUser } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const PatchSchema = z.object({
  displayName: z.string().optional(),
  role: z.enum(["admin", "user"]).optional(),
  // Admin-controlled policy. `quotaLimit` is the size of the user's pool;
  // `quotaUsed` lets an admin top someone up or reset consumption.
  quotaType: z.enum(["credits", "tokens"]).optional(),
  quotaLimit: z.number().int().nonnegative().optional(),
  quotaUsed: z.number().int().nonnegative().optional(),
  maxActiveKeys: z.number().int().nonnegative().optional(),
  allowedModels: z.array(z.string()).optional(),
});

export async function PATCH(
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
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  // Enforce displayName constraints at route layer before they reach UserSchema.parse() → 500
  if (parsed.data.displayName !== undefined) {
    const trimmed = parsed.data.displayName.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: "displayName must be 1–64 characters after trimming" } },
        { status: 400 },
      );
    }
    parsed.data.displayName = trimmed;
  }

  let updated;
  try {
    updated = await updateUser(id, parsed.data);
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: "Invalid user data" } },
        { status: 400 },
      );
    }
    throw err;
  }
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { user: toPublicUser(updated) } });
}

export async function DELETE(
  _req: Request,
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

  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }
  if (user.id === me.id) {
    return NextResponse.json(
      { ok: false, error: { code: "self_delete", message: "Cannot delete your own account" } },
      { status: 400 },
    );
  }

  // Cascade: delete all keys, then the user.
  const keysRemoved = await deleteApiKeysByUser(user.id);
  await deleteUser(user.id);
  return NextResponse.json({
    ok: true,
    data: { deletedUserId: id, keysRemoved },
  });
}
