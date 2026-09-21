/**
 * app/api/admin/providers/[id]/route.ts
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProvider, deleteProvider, getProviderById } from "@/lib/db/providers";
import { toPublicProvider } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const PatchSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(["openai", "anthropic", "custom-openai"]).optional(),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().optional(),
  modelMapping: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
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

  const updated = await updateProvider(id, parsed.data);
  if (!updated) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { provider: toPublicProvider(updated) } });
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
  const ok = await deleteProvider(id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedProviderId: id } });
}

void getProviderById;
