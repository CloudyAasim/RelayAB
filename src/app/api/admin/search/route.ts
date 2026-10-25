/**
 * app/api/admin/search/route.ts
 *
 *   GET /api/admin/search  → current configuration
 *   PUT /api/admin/search  → set the environment fallback's price
 *
 * ## There is no on/off switch here any more
 *
 * There used to be one, and it sat beside the provider list as a second
 * source of truth for a fact the rows already carry: whether the operator
 * wants search right now. The two could disagree — the panel said "on" while
 * `/v1/search` was refusing — and the fix was to give the state one home: the
 * rows.
 *
 * A deployment that had switched search off keeps that meaning: the
 * migration in `src/lib/db/sqlite.ts` folded the switch's "off" into the rows
 * it governed, so the state the operator set is still the state they see.
 *
 * What is left here is the one number that is not on a row: the price of the
 * **environment fallback**, which is the path a deployment uses before it has
 * any provider row at all.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { loadSearchConfig } from "@/lib/search/config";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";

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

const UpdateSchema = z
  .object({
    // Whole credits. The ceiling is a sanity bound, not a pricing opinion: a
    // typo that adds three zeros should be refused rather than billed.
    creditsPerCall: z.number().int().min(0).max(100_000).optional(),
    /**
     * The service that answers when a caller names none.
     *
     * `null` clears it, which puts the deployment back to "the only service
     * that can answer answers, and a refusal when several can".
     */
    defaultServiceId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict()
  .refine((v) => v.creditsPerCall !== undefined || v.defaultServiceId !== undefined, {
    message: "nothing to update",
  });

export async function GET(): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const settings = await getSettings();
  const config = await loadSearchConfig(settings);
  // Usage lives on /admin/usage with everything else. Keeping a second copy
  // here is how the two screens start disagreeing about the same money.
  return NextResponse.json({
    ok: true,
    data: {
      config,
      stored: {
        creditsPerCall: settings.searchCreditsPerCall ?? null,
        defaultServiceId: settings.searchDefaultServiceId ?? null,
      },
      maxResults: MAX_SEARCH_RESULTS,
    },
  });
}

export async function PUT(req: Request): Promise<Response> {
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
  const parsed = UpdateSchema.safeParse(body);
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

  const settings = await updateSettings({
    ...(parsed.data.creditsPerCall !== undefined
      ? { searchCreditsPerCall: parsed.data.creditsPerCall }
      : {}),
    // An empty string is how "no default" is written: the setting is deleted
    // rather than stored empty, because a stored empty value would read as a
    // service nobody has.
    ...(parsed.data.defaultServiceId !== undefined
      ? { searchDefaultServiceId: parsed.data.defaultServiceId ?? "" }
      : {}),
  });
  return NextResponse.json({
    ok: true,
    data: {
      config: await loadSearchConfig(settings),
      stored: {
        creditsPerCall: settings.searchCreditsPerCall ?? null,
        defaultServiceId: settings.searchDefaultServiceId ?? null,
      },
    },
  });
}
