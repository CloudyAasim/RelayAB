/**
 * GET /api/admin/settings - Get current settings
 * PUT /api/admin/settings - Update settings
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { getCurrentUser } from "@/lib/auth/session";
import { loadConfig } from "@/lib/config";

const UpdateSchema = z.object({
  publicUrl: z.string().url().optional(),
});

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  try {
    const settings = await getSettings();
    // Also include the configured public URL (from env or settings)
    const cfg = loadConfig();
    
    return NextResponse.json({
      ok: true,
      data: {
        publicUrl: settings.publicUrl ?? cfg.RELAY_PUBLIC_URL ?? null,
      },
    });
  } catch (err) {
    console.error("[settings GET]", err);
    return NextResponse.json({
      ok: false,
      error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" },
    }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
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

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.message } },
      { status: 400 },
    );
  }

  try {
    const settings = await updateSettings({
      publicUrl: parsed.data.publicUrl,
    });

    return NextResponse.json({
      ok: true,
      data: { settings },
    });
  } catch (err) {
    console.error("[settings PUT]", err);
    return NextResponse.json({
      ok: false,
      error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" },
    }, { status: 500 });
  }
}
