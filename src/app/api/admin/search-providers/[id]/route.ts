/**
 * app/api/admin/search-providers/[id]/route.ts
 *
 *   GET    → one backend
 *   PATCH  → edit it (a blank apiKey keeps the stored one)
 *   DELETE → remove it
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteSearchProvider,
  getSearchProviderById,
  MAX_CREDITS_PER_CALL,
  SearchProviderValidationError,
  toPublicSearchProvider,
  updateSearchProvider,
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

const PatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /**
     * The vendor tag.
     *
     * A free string rather than an enum: a row that carries its own spec may
     * name any vendor, and that is the whole point of the protocol. The three
     * built-ins are what the panel offers as a starting point.
     */
    kind: z.string().trim().min(1).max(60).optional(),
    baseUrl: z.string().max(500).optional(),
    apiKey: z.string().max(500).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    creditsPerCall: z.number().int().min(0).max(MAX_CREDITS_PER_CALL).optional(),
    /** The row's own search spec. `null` returns the row to its template. */
    spec: z.unknown().optional(),
    /** The name clients use to ask for this service. */
    serviceId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;
  const provider = await getSearchProviderById(id);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Search provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { provider: toPublicSearchProvider(provider) } });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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
  const parsed = PatchSchema.safeParse(body);
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

  const { id } = await context.params;
  try {
    const provider = await updateSearchProvider(id, parsed.data);
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "Search provider not found" } },
        { status: 404 },
      );
    }
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

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;
  const removed = await deleteSearchProvider(id);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Search provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedProviderId: id } });
}
