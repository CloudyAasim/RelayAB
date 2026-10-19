/**
 * app/api/admin/search/route.ts
 *
 *   GET /api/admin/search  → current configuration + usage
 *   PUT /api/admin/search  → enable/disable and set the per-call price
 *
 * The panel needs three things in one read: whether the feature is on, what it
 * costs, and whether there is a backend behind it. Reading them separately is
 * how a page comes to say "enabled" while `/v1/search` is returning 503.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getSettings, updateSettings } from "@/lib/db/settings";
import { listRecentSearchUsage, searchUsageTotals } from "@/lib/db/usage";
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
    enabled: z.boolean().optional(),
    // Whole credits. The ceiling is a sanity bound, not a pricing opinion: a
    // typo that adds three zeros should be refused rather than billed.
    creditsPerCall: z.number().int().min(0).max(100_000).optional(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.creditsPerCall !== undefined, {
    message: "nothing to update",
  });

export async function GET(): Promise<Response> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const settings = await getSettings();
  const config = await loadSearchConfig(settings);
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [last24h, last7d, total, recent] = await Promise.all([
    searchUsageTotals(since24h),
    searchUsageTotals(since7d),
    searchUsageTotals(),
    listRecentSearchUsage(20),
  ]);

  // The stored values are reported apart from the effective ones: an operator
  // who has not touched the panel is running on the environment/default, and
  // "1" without that distinction looks like a saved choice.
  return NextResponse.json({
    ok: true,
    data: {
      config,
      stored: {
        enabled: settings.searchEnabled ?? null,
        creditsPerCall: settings.searchCreditsPerCall ?? null,
      },
      maxResults: MAX_SEARCH_RESULTS,
      stats: { last24h, last7d, total },
      recent,
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
    ...(parsed.data.enabled !== undefined ? { searchEnabled: parsed.data.enabled } : {}),
    ...(parsed.data.creditsPerCall !== undefined
      ? { searchCreditsPerCall: parsed.data.creditsPerCall }
      : {}),
  });
  return NextResponse.json({
    ok: true,
    data: {
      config: await loadSearchConfig(settings),
      stored: {
        enabled: settings.searchEnabled ?? null,
        creditsPerCall: settings.searchCreditsPerCall ?? null,
      },
    },
  });
}
