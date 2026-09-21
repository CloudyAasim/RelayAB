/**
 * app/api/auth/change-password/route.ts
 *
 * POST /api/auth/change-password
 * Body: { currentPassword: string, newPassword: string, confirmPassword: string }
 *
 * Self-service password change for the currently authenticated user.
 * Requires the user to verify by typing their current password, then
 * type the new password twice (in `newPassword` and `confirmPassword`).
 *
 * This is what unlocks the "用户能改自己的密码" requirement: a regular
 * user (no admin involvement) can rotate their own password from the UI.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById, resetUserPassword } from "@/lib/db/users";
import { verifyPassword } from "@/lib/crypto/password";

const BodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(1),
});

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }

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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid input" } },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword, confirmPassword } = parsed.data;

  // ---- 1. Two new-password fields must match ----
  if (newPassword !== confirmPassword) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "password_mismatch",
          message: "The two new passwords do not match. Please re-type them.",
        },
      },
      { status: 400 },
    );
  }

  // ---- 2. Length sanity (mirrors crypto/password.ts) ----
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "password_too_short",
          message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        },
      },
      { status: 400 },
    );
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "password_too_long",
          message: `New password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
        },
      },
      { status: 400 },
    );
  }

  // ---- 3. New password must differ from old ----
  if (newPassword === currentPassword) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "password_unchanged",
          message: "New password must be different from the current one.",
        },
      },
      { status: 400 },
    );
  }

  // ---- 4. Verify the CURRENT password ----
  const fullUser = await getUserById(me.id);
  if (!fullUser) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "User no longer exists" } },
      { status: 404 },
    );
  }
  const currentOk = await verifyPassword(currentPassword, fullUser.passwordHash);
  if (!currentOk) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "wrong_current_password",
          message: "The current password you entered is incorrect.",
        },
      },
      { status: 403 },
    );
  }

  // ---- 5. Commit the new password ----
  const updated = await resetUserPassword(me.id, newPassword);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "update_failed", message: "Could not update password" } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: { username: updated.username },
  });
}
