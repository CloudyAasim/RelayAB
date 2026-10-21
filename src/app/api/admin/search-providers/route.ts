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
  MAX_CREDITS_PER_CALL,
  SearchProviderValidationError,
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
    /**
     * The vendor tag.
     *
     * A free string rather than an enum: a row that carries its own spec may
     * name any vendor, and that is the whole point of the protocol. The three
     * built-ins are what the panel offers as a starting point.
     */
    kind: z.string().trim().min(1).max(60),
    baseUrl: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    creditsPerCall: z.number().int().min(0).max(MAX_CREDITS_PER_CALL).optional(),
    /** The row's own search spec — a vendor this build has no template for. */
    spec: z.unknown().optional(),
    /** The name clients use to ask for this service. Derived from the name if absent. */
    serviceId: z.string().trim().min(1).max(64).optional(),
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
