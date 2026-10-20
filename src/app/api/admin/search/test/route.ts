/**
 * app/api/admin/search/test/route.ts
 *
 *   POST /api/admin/search/test  → run one query against the backend
 *
 * **The test is a real search and is billed as one.** It goes through the same
 * settlement as `POST /v1/search`: the account that pressed the button pays the
 * price, the call is recorded in the usage tables, and the balance moves.
 *
 * It used to be free, and that was wrong in a way nobody could see: the
 * operator pays the vendor either way, so a free test is a free ride on a paid
 * API, and the only place that showed up was the vendor's invoice. A test that
 * costs what it uses is also a test that tells the truth about what a client
 * would be charged.
 *
 * What it is *not* gated on is the provider being enabled — this is the button
 * an operator presses to find out why search is not working, and a diagnostic
 * that refuses to run while the feature is failing diagnoses nothing. It still
 * returns the backend's own error verbatim, and a failed search is not charged.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_RESULTS,
  WebSearchError,
} from "@/lib/assistant/web-search";
import { attributionKeyFor, runBilledSearch } from "@/lib/search/billing";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const session = await getCurrentUser();
  if (!session || session.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }
  // The full account row, not the session's copy of it: the quota and the
  // balance that gets charged live on the user record.
  const me = await getUserById(session.id);
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Account not found" } },
      { status: 404 },
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
    // A credit that cannot be seen in any report is a credit nobody can
    // audit, and a usage row has to hang off a real key. An account with no
    // key at all cannot be charged this way, so the call is refused with the
    // one thing that would fix it.
    const apiKeyId = await attributionKeyFor(me.id);
    if (!apiKeyId) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "no_key_to_charge",
            message: "这个账号还没有密钥，无法记账 —— 先在「我的密钥与额度」里创建一把，再来测试。",
          },
        },
        { status: 400 },
      );
    }

    const settled = await runBilledSearch({
      query: parsed.data.query,
      limit: parsed.data.limit ?? 5,
      user: me,
      apiKeyId,
      // No key was used — a person pressed a button — so no key is marked used.
      touchKey: false,
    });
    return NextResponse.json({
      ok: true,
      data: {
        provider: settled.outcome.provider,
        backend: settled.outcome.backend,
        query: settled.outcome.query,
        results: settled.outcome.results,
        latencyMs: Date.now() - started,
        // The price this call cost, and the balance it left behind. Saying so
        // stops the next reader from wondering why the account balance moved.
        credits: settled.credits,
        remaining: settled.user
          ? Math.max(0, settled.user.quotaLimit - settled.user.quotaUsed)
          : null,
        billed: true,
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
