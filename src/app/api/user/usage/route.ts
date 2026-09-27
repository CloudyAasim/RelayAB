/**
 * app/api/user/usage/route.ts
 *
 * GET /api/user/usage?range=today|7d|30d|90d|all|custom&from=&to=&tzOffset=
 *
 * Usage report scoped to the signed-in account (all of their keys). Same
 * shape as `/api/admin/usage` minus the per-user breakdown.
 */
import { NextResponse } from "next/server";
import { listApiKeysByUser } from "@/lib/db/keys";
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

  const keyPage = await listApiKeysByUser(me.id, { limit: 200 });
  const report = await loadUsageReportCached({
    keyIds: keyPage.keys.map((key) => key.id),
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
