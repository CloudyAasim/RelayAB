/**
 * app/api/admin/search-providers/[id]/test/route.ts
 *
 *   POST → run one query through exactly this provider
 *
 * **The test is a real search and is billed as one** — the same settlement
 * `POST /v1/search` uses, at *this row's* price. A test that ran the vendor's
 * API for free was a free ride on a paid API, and the only place that showed up
 * was the vendor's invoice.
 *
 * Deliberately not gated on `enabled`: the operator presses this to find out
 * whether a provider works, and a diagnostic that refuses to run on a disabled
 * provider cannot answer the question it exists for. A **failed** search is not
 * charged — it produced nothing to bill for.
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
import { getSearchProviderById } from "@/lib/db/search-providers";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
  })
  .strict();

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await context.params;

  // A provider that is not there is a 404, not a failed search: the question
  // "does this backend work?" has no subject.
  const row = await getSearchProviderById(id);
  if (!row) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Search provider not found" } },
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
    // audit, and a usage row has to hang off a real key.
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
      // This provider, whether or not it is the one currently serving.
      providerId: id,
    });
    return NextResponse.json({
      ok: true,
      data: {
        providerId: settled.outcome.providerId,
        provider: settled.outcome.provider,
        backend: settled.outcome.backend,
        query: settled.outcome.query,
        results: settled.outcome.results,
        latencyMs: Date.now() - started,
        // The price this call cost, and the balance it left behind.
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
    // A balance that cannot cover the call is a refusal, not a search failure:
    // 429, and the call never reached the vendor.
    if (err instanceof WebSearchError && err.code === "quota_exceeded") {
      return NextResponse.json(
        { ok: false, error: { code: "quota_exceeded_credits", message } },
        { status: 429 },
      );
    }
    // A row that exists but cannot answer is a bad configuration (400), not a
    // missing backend (503): the question "does this provider work?" has a
    // subject, and the answer is "this configuration cannot work".
    const unusable = err instanceof WebSearchError && err.code === "not_configured";
    return NextResponse.json(
      { ok: false, error: { code: unusable ? "bad_request" : "search_failed", message } },
      { status: unusable ? 400 : 502 },
    );
  }
}
