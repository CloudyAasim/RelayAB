/**
 * app/api/admin/media-providers/[id]/route.ts
 *
 * GET    /api/admin/media-providers/[id]
 * PATCH  /api/admin/media-providers/[id]  → edit fields and/or replace specs
 * DELETE /api/admin/media-providers/[id]
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  deleteMediaProvider,
  getMediaProviderById,
  toPublicMediaProvider,
  updateMediaProvider,
  MediaProviderValidationError,
} from "@/lib/db/media-providers";
import { parseMediaSpec } from "@/lib/media/spec";

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

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;
  const provider = await getMediaProviderById(id);
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { provider: toPublicMediaProvider(provider) } });
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = (parsed ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  if (Array.isArray(body.specs)) {
    const issues: string[] = [];
    body.specs.forEach((entry, index) => {
      const parsed = parseMediaSpec(entry);
      if (!parsed.ok) issues.push(`specs[${index}]: ${parsed.errors.join("; ")}`);
    });
    if (issues.length > 0) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: issues.join(" | ") } },
        { status: 400 },
      );
    }
  }

  try {
    const provider = await updateMediaProvider(id, {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl.trim() } : {}),
      ...(typeof body.apiKey === "string" && body.apiKey ? { apiKey: body.apiKey } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
      ...(body.models ? { models: body.models as never } : {}),
      ...(Array.isArray(body.specs) ? { specs: body.specs } : {}),
    });
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "Provider not found" } },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, data: { provider: toPublicMediaProvider(provider) } });
  } catch (err) {
    if (err instanceof MediaProviderValidationError) {
      return NextResponse.json(
        { ok: false, error: { code: "bad_request", message: err.issues.join(" | ") } },
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
  const ok = await deleteMediaProvider(id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Provider not found" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, data: { deletedProviderId: id } });
}
