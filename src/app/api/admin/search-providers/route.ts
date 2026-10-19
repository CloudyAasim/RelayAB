/**
 * app/api/admin/search-providers/route.ts
 *
 *   GET  /api/admin/search-providers  → every stored backend
 *   POST /api/admin/search-providers  → add one
 *
 * Same shape as the media-provider routes: a list read, a zod-validated
 * create, and never a ciphertext in a response.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  createSearchProvider,
  listSearchProviders,
  SearchProviderValidationError,
  SEARCH_PROVIDER_KINDS,
  toPublicSearchProvider,
} from "@/lib/db/search-providers";

export const dynamic = "force-dynamic";

async function requireAdmin(): Promise<NextResponse | null> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  return null;
}

const CreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(SEARCH_PROVIDER_KINDS),
    baseUrl: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const providers = await listSearchProviders();
  return NextResponse.json({
    ok: true,
    data: { providers: providers.map(toPublicSearchProvider) },
  });
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "bad_request",
          message: parsed.error.issues.map((i) => i.message).join("; ") || "invalid body",
        },
      },
      { status: 400 },
    );
  }

  try {
    const provider = await createSearchProvider(parsed.data);
    return NextResponse.json({
      ok: true,
      data: { provider: toPublicSearchProvider(provider) },
    });
  } catch (err) {
    if (err instanceof SearchProviderValidationError) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: err.issues.join("; ") } },
        { status: 400 },
      );
    }
    throw err;
  }
}
