/**
 * app/api/admin/keys/[id]/toggle/route.ts
 *
 * POST /api/admin/keys/[id]/toggle  body: { enabled?: boolean, forceDisabled?: boolean }
 *
 * Quick endpoint for enabling/disabling a key and force-disabling by admin.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateApiKey } from "@/lib/db/keys";
import { getCurrentUser } from "@/lib/auth/session";

const BodySchema = z.object({
  enabled: z.boolean().optional(),
  forceDisabled: z.boolean().optional(),
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
      { ok: false, error: { code: "bad_request", message: "Invalid request body" } },
      { status: 400 },
    );
  }

  if (parsed.data.enabled === undefined && parsed.data.forceDisabled === undefined) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: "At least one of enabled or forceDisabled is required" } },
      { status: 400 },
    );
  }

  const updated = await updateApiKey(id, {
    enabled: parsed.data.enabled,
    forceDisabled: parsed.data.forceDisabled,
  });
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "API key not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { key: updated } });
}
