/**
 * app/api/admin/providers/[id]/route.ts
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProvider, deleteProvider, getProviderById } from "@/lib/db/providers";
import { toPublicProvider, ModelConfigPatchSchema } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";
import { validateTextSpecs } from "@/lib/protocol/text-specs";

export const PatchSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(["openai", "anthropic", "custom-openai", "azure"]).optional(),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().optional(),
  modelMapping: z.record(z.string(), z.string()).optional(),
  modelConfigs: z.record(z.string(), ModelConfigPatchSchema).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  upstreamFormat: z.enum(["responses", "chat", "anthropic"]).optional(),
  openaiEnabled: z.boolean().optional(),
  anthropicEnabled: z.boolean().optional(),
  anthropicBaseUrl: z.string().nullable().optional(),
  /**
   * The wire protocols, one JSON document per compatibility interface.
   *
   * Validated here rather than on read, so a spec that is wrong is refused at
   * the moment the operator writes it — a spec that parses on the way in and
   * then does nothing on the way out is the worst of both. An empty list is the
   * documented "forward everything as sent" state, so this is also how a
   * protocol is removed.
   */
  textSpecs: z
    .array(z.string().max(200_000))
    .max(12)
    .optional()
    .superRefine((value, ctx) => {
      const result = validateTextSpecs(value ?? []);
      if (result.ok) return;
      for (const message of result.errors) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      }
    }),
  /**
   * Which configuration is live. Absent leaves the stored choice alone; `null`
   * hands the row back to following its rules if it has any.
   *
   * This schema is `.strict()`, so the field has to be declared here — an
   * editor that starts sending it is otherwise rejected wholesale, and the
   * failure reads as "the whole save was refused" rather than "one new field".
   */
  activeMode: z.enum(["simple", "advanced"]).nullable().optional(),
  })
  .strict();

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
