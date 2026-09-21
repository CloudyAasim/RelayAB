/**
 * app/api/admin/keys/[id]/route.ts
 *
 * PATCH  /api/admin/keys/[id]  body: { label?, quotaType?, quotaLimit?, expiresAt?, allowedModels?, enabled? }
 * DELETE /api/admin/keys/[id]
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateApiKey, deleteApiKey, getApiKeyById } from "@/lib/db/keys";
import { getCurrentUser } from "@/lib/auth/session";

const PatchSchema = z.object({
  label: z.string().optional(),
  quotaType: z.enum(["credits", "tokens"]).optional(),
  quotaLimit: z.number().int().nonnegative().optional(),
  expiresAt: z.string().nullable().optional(),
  allowedModels: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
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

  const updated = await updateApiKey(id, parsed.data);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "API key not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { key: updated } });
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
  const ok = await deleteApiKey(id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "API key not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedKeyId: id } });
}

// Suppress unused-import warning when GET isn't defined here
void getApiKeyById;
