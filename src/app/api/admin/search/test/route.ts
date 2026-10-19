/**
 * app/api/admin/search/test/route.ts
 *
 *   POST /api/admin/search/test  → run one query against the backend
 *
 * Deliberately **not billed** and **not gated on the enabled switch**: this is
 * the button an operator presses to find out why search is not working, and a
 * diagnostic that refuses to run while the feature is failing diagnoses
 * nothing. It still returns the backend's own error verbatim.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  searchWeb,
  WebSearchError,
} from "@/lib/assistant/web-search";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
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
      { ok: false, error: { code: "bad_json", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { code: "bad_request", message: parsed.error.issues[0]?.message ?? "invalid body" } },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const outcome = await searchWeb(parsed.data.query, {
      limit: parsed.data.limit ?? 5,
    });
    return NextResponse.json({
      ok: true,
      data: {
        provider: outcome.provider,
        backend: outcome.backend,
        query: outcome.query,
        results: outcome.results,
        latencyMs: Date.now() - started,
        // Billing is off for this path, and saying so stops the next reader
        // from wondering why the account balance did not move.
        billed: false,
      },
    });
  } catch (err) {
    const message =
      err instanceof WebSearchError
        ? err.message
        : `搜索失败：${err instanceof Error ? err.message : String(err)}`;
    return NextResponse.json(
      { ok: false, error: { code: "search_failed", message } },
      { status: err instanceof WebSearchError && err.code === "not_configured" ? 503 : 502 },
    );
  }
}
