/**
 * app/api/admin/providers/route.ts
 *
 * GET  /api/admin/providers
 * POST /api/admin/providers  body: { name, kind, baseUrl?, apiKey, modelMapping?, modelConfigs?, enabled?, priority? }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProvider, listProviders } from "@/lib/db/providers";
import { toPublicProvider } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const PostSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(["openai", "anthropic", "custom-openai", "azure"]),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().min(1),
  modelMapping: z.record(z.string(), z.string()).optional(),
  modelConfigs: z.record(z.string(), z.object({
    upstreamId: z.string(),
    clientId: z.string(),
    displayName: z.string().optional(),
    contextLength: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCost: z.number().nonnegative().optional(),
    outputCost: z.number().nonnegative().optional(),
    enabled: z.boolean().optional(),
  })).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  upstreamFormat: z.enum(["responses", "chat", "anthropic"]).optional(),
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
