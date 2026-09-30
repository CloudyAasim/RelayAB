/**
 * app/api/admin/media-providers/route.ts
 *
 * GET  /api/admin/media-providers → list (API key never included)
 * POST /api/admin/media-providers → create a provider and its specs
 *
 * This is the whole point of the media adapter protocol: a new vendor is a new
 * row here, written as JSON. No code change, no redeploy.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  createMediaProvider,
  listMediaProviders,
  toPublicMediaProvider,
  MediaProviderValidationError,
} from "@/lib/db/media-providers";
import { validateMediaSpecs } from "@/lib/media/spec";

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

export async function GET(): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;
  const providers = await listMediaProviders();
  return NextResponse.json({
    ok: true,
    data: { providers: providers.map(toPublicMediaProvider) },
  });
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;

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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!name || !baseUrl || !apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "bad_request", message: "name, baseUrl and apiKey are required" },
      },
      { status: 400 },
    );
  }

  // Dry-run the specs so a typo is reported here rather than on a live call.
  const { errors: specIssues, warnings: specWarnings } = validateMediaSpecs(body.specs);
  if (specIssues.length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: specIssues.join(" | ") } },
      { status: 400 },
    );
  }

  try {
    const provider = await createMediaProvider({
      name,
      baseUrl,
      apiKey,
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
      ...(body.models ? { models: body.models as never } : {}),
      ...(Array.isArray(body.specs) ? { specs: body.specs } : {}),
    });
    return NextResponse.json({
      ok: true,
      data: { provider: toPublicMediaProvider(provider) },
      // Non-fatal notes ("a poll path with no {{taskId}}", …) so the panel can
      // show them next to the form instead of burying them in server logs.
      ...(specWarnings.length > 0 ? { warnings: specWarnings } : {}),
    });
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
