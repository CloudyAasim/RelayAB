/**
 * app/api/admin/users/[id]/reset-password/route.ts
 *
 * POST /api/admin/users/[id]/reset-password
 * Generates a new random password and returns it ONCE.
 */
import { NextResponse } from "next/server";
import { resetUserPassword } from "@/lib/db/users";
import { generateInitialPassword } from "@/lib/crypto/password";
import { getCurrentUser } from "@/lib/auth/session";

export async function POST(
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

  const newPassword = generateInitialPassword();
  const updated = await resetUserPassword(id, newPassword);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "User not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: { userId: id, generatedPassword: newPassword },
  });
}
