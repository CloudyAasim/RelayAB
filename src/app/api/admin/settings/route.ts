/**
 * app/api/admin/settings/route.ts
 *
 *   GET /api/admin/settings   → current settings
 *   PUT /api/admin/settings   → update them
 *
 * Two kinds of setting live here and the schema keeps them apart:
 *
 *   `publicUrl` is **operational** — it changes the address the app tells the
 *   world to use, so it is validated as a URL and merged over the env value.
 *
 *   The rest (`siteName`, `siteDescription`, `announcement`,
 *   `supportContact`, `modelNotes`) is **presentation** — it only changes what
 *   the docs page says. Nothing in the request path reads it, which is why it
 *   needs no URL validation and why a copy edit can never become a routing
 *   change.
 *
 *   `modelNotes` is keyed by client-visible model id and can only carry
 *   prose (`displayName`, `note`, `tags`, `hidden`). It deliberately has no
 *   field for a context window or a price: those are facts, and facts are
 *   read live from the provider table so the docs cannot contradict the
 *   gateway. See `lib/docs/catalog.ts`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { getCurrentUser } from "@/lib/auth/session";
import { buildModelCatalog } from "@/lib/docs/catalog";
import { loadConfig } from "@/lib/config";

const ModelNoteSchema = z
  .object({
    displayName: z.string().max(120).optional(),
    note: z.string().max(2000).optional(),
    tags: z.array(z.string().max(40)).max(8).optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

const UpdateSchema = z
  .object({
    publicUrl: z.string().url().optional(),
    siteName: z.string().max(120).optional(),
    siteDescription: z.string().max(500).optional(),
    announcement: z.string().max(20_000).optional(),
    supportContact: z.string().max(500).optional(),
    publicCatalog: z.boolean().optional(),
    modelNotes: z.record(z.string().min(1).max(200), ModelNoteSchema).optional(),
  })
  .strict();

export const dynamic = "force-dynamic";

function denied(): Response {
  return NextResponse.json(
    { ok: false, error: { code: "forbidden", message: "Admin required" } },
    { status: 403 },
  );
}

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") return denied();

  try {
    const [settings, catalog] = await Promise.all([getSettings(), buildModelCatalog()]);
    const cfg = loadConfig();

    return NextResponse.json({
      ok: true,
      data: {
        settings,
        // The env value is shown as the fallback it is, not as if it were a
        // stored setting — an operator editing the field should know which
        // one they are actually changing.
        envPublicUrl: cfg.RELAY_PUBLIC_URL ?? null,
        // Which models exist, so the notes editor can offer the real ids
        // instead of making the operator type them from memory.
        models: catalog.models.map((m) => ({ id: m.id, kind: m.kind, displayName: m.displayName })),
      },
    });
  } catch (err) {
    console.error("[settings GET]", err);
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" } },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") return denied();

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
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "参数不合法" } },
      { status: 400 },
    );
  }

  try {
    const settings = await updateSettings(parsed.data);
    return NextResponse.json({ ok: true, data: { settings } });
  } catch (err) {
    console.error("[settings PUT]", err);
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" } },
      { status: 500 },
    );
  }
}
