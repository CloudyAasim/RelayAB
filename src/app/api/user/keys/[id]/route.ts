/**
 * app/api/user/keys/[id]/route.ts
 *
 * Self-service update / delete of the current user's own API key.
 *
 *   PATCH  /api/user/keys/[id]  body: { label?, enabled?, expiresAt? }
 *   DELETE /api/user/keys/[id]
 *
 * The user can ONLY touch their own keys (verified by userId).
 * They CANNOT change quota / allowedModels / quotaType — those are
 * admin-controlled via the user's allocation; only the admin can
 * override them (via /api/admin/keys).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/db/keys";

const PatchSchema = z.object({
  label: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  expiresAt: z.string().nullable().optional(),
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { id } = await context.params;

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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid input" } },
      { status: 400 },
    );
  }

  // Ownership check — user must own this key.
  const existing = await getApiKeyById(id);
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "API key not found" } },
      { status: 404 },
    );
  }
  if (existing.userId !== me.id) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "You do not own this API key" } },
      { status: 403 },
    );
  }

  // Prevent user from enabling a force-disabled key
  if (parsed.data.enabled === true && existing.forceDisabled) {
    return NextResponse.json(
      { ok: false, error: { code: "key_force_disabled", message: "This key has been disabled by the administrator and cannot be enabled" } },
      { status: 403 },
    );
  }

  const updated = await updateApiKey(id, parsed.data);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "update_failed", message: "Could not update key" } },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, data: { key: updated } });
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  const { id } = await context.params;

  const existing = await getApiKeyById(id);
  if (!existing) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "API key not found" } },
      { status: 404 },
    );
  }
  if (existing.userId !== me.id) {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "You do not own this API key" } },
      { status: 403 },
    );
  }

  const ok = await deleteApiKey(id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: { code: "delete_failed", message: "Could not delete key" } },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedId: id } });
}
