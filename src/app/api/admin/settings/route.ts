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
import { revalidatePath } from "next/cache";
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

/** A slug: lowercase, dashes, nothing a reader could mistake for a route. */
const DocPageIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "页面标识只能用小写字母、数字和中划线");

const DocPageSchema = z
  .object({
    id: DocPageIdSchema,
    title: z.string().min(1).max(120),
    // Markdown, capped. It is rendered by the same escaping path as the built-in
    // docs, so it is text — but it is still a body of prose typed by a human, and
    // an unbounded one would be a body of prose nobody can finish reading.
    body: z.string().max(60_000),
    hidden: z.boolean().optional(),
    order: z.number().int().min(0).max(10_000).optional(),
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
    // Capped as a whole as well as per page: the list is rendered into the
    // reader's navigation, and a hundred entries there is a hundred entries
    // nobody scrolls past.
    docPages: z.array(DocPageSchema).max(30).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Two pages with one id would render two chapters at the same anchor, and
    // the second would silently never be reachable.
    const seen = new Set<string>();
    for (const [i, page] of (value.docPages ?? []).entries()) {
      if (seen.has(page.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["docPages", i, "id"],
          message: `页面标识「${page.id}」重复了`,
        });
      }
      seen.add(page.id);
    }
  });

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

    // Everything on this form is documentation, and the docs render it into
    // their own outline. Say so to the server cache, or a reader can be served
    // an outline that predates the save.
    //
    // This is the server half of the fix; the other half is in `DocsShell`,
    // which opts its links out of prefetching, because the 30-second client
    // router cache in `next.config.mjs` would otherwise hand back a payload
    // fetched before the operator ever pressed save.
    for (const path of ["/docs", "/dashboard/docs", "/admin/docs"]) {
      revalidatePath(path, "layout");
    }

    return NextResponse.json({ ok: true, data: { settings } });
  } catch (err) {
    console.error("[settings PUT]", err);
    return NextResponse.json(
      { ok: false, error: { code: "server_error", message: err instanceof Error ? err.message : "Unknown error" } },
      { status: 500 },
    );
  }
}
