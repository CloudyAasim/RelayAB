/**
 * app/api/user/usage/route.ts
 *
 * GET /api/user/usage?range=today|7d|30d|90d|all|custom&from=&to=&tzOffset=
 *
 * Usage report scoped to the signed-in account (all of their keys). Same
 * shape as `/api/admin/usage` minus the per-user breakdown.
 */
import { NextResponse } from "next/server";
import { listApiKeyIdsForUsage } from "@/lib/db/keys";
import { getCurrentUser } from "@/lib/auth/session";
import { loadUsageReportCached } from "@/lib/usage/load";
import { parseTzOffset, rangeToJson, resolveRange } from "@/lib/usage/report";

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Sign in required" } },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const tzOffsetMinutes = parseTzOffset(url.searchParams.get("tzOffset"));
  const range = resolveRange({
    key: url.searchParams.get("range") ?? "all",
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    tzOffsetMinutes,
  });

  // Every key this account's balance can be charged through, not the subset the
  // account is allowed to use: the assistant credential is deliberately hidden
  // from `listApiKeysByUser`, but the calls it makes are billed to this user
  // and belong in this report. Using the management list here is what made
  // 「用我的账号身份」 spend money that no usage page would ever show.
  const keyIds = await listApiKeyIdsForUsage(me.id);

  const report = await loadUsageReportCached({
    keyIds,
    tzOffsetMinutes,
    range,
  });

  return NextResponse.json({
    ok: true,
    data: {
      range: rangeToJson(report.range),
      summary: report.summary,
      series: report.series,
      byKey: report.byKey,
      byModel: report.byModel,
      byProvider: report.byProvider,
      truncatedKeys: report.truncatedKeys,
    },
  });
}
