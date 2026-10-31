/**
 * app/api/admin/providers/route.ts
 *
 * GET  /api/admin/providers
 * POST /api/admin/providers  body: { name, kind, baseUrl?, apiKey, modelMapping?, modelConfigs?, enabled?, priority? }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProvider, listProviders } from "@/lib/db/providers";
import { toPublicProvider, ModelConfigPatchSchema } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";
import { validateTextSpecs } from "@/lib/protocol/text-specs";
import { parseRoutes } from "@/lib/protocol/surface-routes";

export const PostSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(["openai", "anthropic", "custom-openai", "azure", "gemini"]),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().min(1),
  modelMapping: z.record(z.string(), z.string()).optional(),
  modelConfigs: z.record(z.string(), ModelConfigPatchSchema).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  upstreamFormat: z.enum(["responses", "chat", "anthropic", "gemini"]).optional(),
  openaiEnabled: z.boolean().optional(),
  anthropicEnabled: z.boolean().optional(),
  anthropicBaseUrl: z.string().nullable().optional(),
  anthropicMode: z.enum(["native", "translated"]).optional(),
  /**
   * The wire protocols, one JSON document per compatibility interface.
   *
   * Validated here rather than on read: a spec that parses on the way in and
   * then does nothing on the way out is a configuration that looks set and is
   * not, and the operator is the only one who can tell.
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
   * Which of the two stored configurations is live.
   *
   * `null` is accepted and means "no opinion" — the row then follows its rules
   * if it has any, which is what every row created before this field existed
   * should keep doing. `simple` switches them off without deleting them.
   */
  activeMode: z.enum(["simple", "advanced"]).nullable().optional(),
  /**
   * How each client surface reaches this provider — the canonical answer.
   *
   * Validated here rather than on read, for the same reason the specs are: a
   * route that does not parse is a configuration that looks set and is not.
   */
  surfaceRoutes: z
    .array(z.string().max(20_000))
    .max(8)
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      const parsed = parseRoutes(value);
      if (parsed) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "接口路由表里有一条读不出来",
      });
    }),
  /**
   * Which configuration is in effect.
   *
   * `null` is accepted and means "no opinion" — the row then follows the
   * columns that came before it, which is what every row created before this
   * field existed should keep doing.
   */
  protocolMode: z.enum(["simple", "advanced", "passthrough"]).nullable().optional(),
  /** The dialects the vendor's own API speaks. Advanced mode reads it. */
  upstreamDialects: z
    .array(z.enum(["chat", "responses", "anthropic", "gemini"]))
    .max(4)
    .optional(),
});

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  try {
    const providers = await listProviders();
    return NextResponse.json({
      ok: true,
      data: { providers: providers.map(toPublicProvider) },
    });
  } catch (err) {
    console.error("[providers GET]", err);
    return NextResponse.json({
      ok: false,
      error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" },
    }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON in request body" } },
      { status: 400 },
    );
  }
  
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  try {
    const provider = await createProvider({
      name: parsed.data.name,
      kind: parsed.data.kind,
      baseUrl: parsed.data.baseUrl ?? null,
      apiKey: parsed.data.apiKey,
      modelMapping: parsed.data.modelMapping ?? {},
      modelConfigs: parsed.data.modelConfigs ?? {},
      enabled: parsed.data.enabled ?? true,
      priority: parsed.data.priority ?? 1,
      headers: parsed.data.headers,
      upstreamFormat: parsed.data.upstreamFormat ?? "responses",
      openaiEnabled: parsed.data.openaiEnabled,
      anthropicEnabled: parsed.data.anthropicEnabled,
      anthropicBaseUrl: parsed.data.anthropicBaseUrl ?? null,
      anthropicMode: parsed.data.anthropicMode ?? "native",
      textSpecs: parsed.data.textSpecs ?? [],
      activeMode: parsed.data.activeMode ?? null,
      surfaceRoutes: parsed.data.surfaceRoutes ?? [],
      protocolMode: parsed.data.protocolMode ?? null,
      upstreamDialects: parsed.data.upstreamDialects ?? [],
    });
    return NextResponse.json({
      ok: true,
      data: { provider: toPublicProvider(provider) },
    });
  } catch (err) {
    console.error("[providers POST]", err);
    return NextResponse.json({
      ok: false,
      error: { code: "server_error", message: err instanceof Error ? err.message : "Failed to create provider" },
    }, { status: 500 });
  }
}
