/**
 * app/api/docs/catalog/route.ts
 *
 *   GET /api/docs/catalog
 *
 * The live model catalogue for the docs page.
 *
 * Read by any signed-in user, because knowing what a deployment actually
 * serves is not admin information — it is the reason the page exists. The
 * facts are read live from the provider tables on every call; only the
 * operator's own prose is stored, so the two can never drift apart here.
 *
 * Deliberately not cached: a catalogue that lags the gateway is the exact
 * problem this endpoint solves. It reads two small indexed tables.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { buildModelCatalog } from "@/lib/docs/catalog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthenticated", message: "Login required" } },
      { status: 401 },
    );
  }
  return NextResponse.json({ ok: true, data: { catalog: await buildModelCatalog() } });
}
