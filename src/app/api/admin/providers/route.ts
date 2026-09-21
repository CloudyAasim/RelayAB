/**
 * app/api/admin/providers/route.ts
 *
 * GET  /api/admin/providers
 * POST /api/admin/providers  body: { name, kind, baseUrl?, apiKey, modelMapping?, enabled?, priority? }
 *
 * NOTE: provider list responses NEVER include the encrypted API key.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProvider, listProviders } from "@/lib/db/providers";
import { toPublicProvider } from "@/lib/db/types";
import { getCurrentUser } from "@/lib/auth/session";

const PostSchema = z.object({
  name: z.string().min(1).max(64),
  kind: z.enum(["openai", "anthropic", "custom-openai"]),
  baseUrl: z.string().nullable().optional(),
  apiKey: z.string().min(1),
  modelMapping: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  const providers = await listProviders();
  return NextResponse.json({
    ok: true,
    data: { providers: providers.map(toPublicProvider) },
  });
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
      { ok: false, error: { code: "bad_json", message: "Invalid JSON" } },
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

  const provider = await createProvider({
    name: parsed.data.name,
    kind: parsed.data.kind,
    baseUrl: parsed.data.baseUrl ?? null,
    apiKey: parsed.data.apiKey,
    modelMapping: parsed.data.modelMapping ?? {},
    enabled: parsed.data.enabled ?? true,
    priority: parsed.data.priority ?? 1,
  });
  return NextResponse.json({
    ok: true,
    data: { provider: toPublicProvider(provider) },
  });
}
