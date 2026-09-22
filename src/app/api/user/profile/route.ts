/**
 * app/api/user/profile/route.ts
 *
 * PATCH /api/user/profile — self-service profile update.
 *
 * Body: { displayName: string }
 *
 * Only fields a user is allowed to change about themselves live here. Role,
 * quota, `allowedModels` and `disabled` are admin-controlled policy and stay
 * behind /api/admin/users.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, getSession } from "@/lib/auth/session";
import { updateUser } from "@/lib/db/users";
import { toPublicUser } from "@/lib/db/types";

const BodySchema = z.object({
  // Matches UserSchema's displayName bounds so a value accepted here can never
  // fail validation on the way into Redis.
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required")
    .max(64, "Display name must be 64 characters or fewer"),
});

export async function PATCH(req: Request): Promise<Response> {
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
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  const updated = await updateUser(me.id, { displayName: parsed.data.displayName });
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "user_not_found", message: "User no longer exists" } },
      { status: 404 },
    );
  }

  // Refresh the cached copy in the session cookie, otherwise the shell keeps
  // rendering the old name until the next login.
  const session = await getSession();
  session.displayName = updated.displayName;
  await session.save();

  return NextResponse.json({ ok: true, data: { user: toPublicUser(updated) } });
}
