/**
 * app/api/admin/usage/route.ts
 *
 * GET /api/admin/usage?range=today|7d|30d|90d|all|custom&from=&to=
 *                     &userId=&tzOffset=
 *
 * Deployment-wide usage report. Totals for `range=all` come from each key's
 * running counter (`UsageTotals` hash), so they stay accurate regardless of
 * the per-key log cap. Range and breakdown figures scan the retained logs.
 *
 * The response keeps the v1 `totals` + `breakdown` shape and adds the richer
 * `summary` / `series` / `byKey` / `byModel` / `byUser` fields the usage page
 * consumes. See docs/api-routes.md.
 */
import { NextResponse } from "next/server";
import { listAllApiKeyIdsForUsage } from "@/lib/db/keys";
import { getCurrentUser } from "@/lib/auth/session";
import { loadUsageReportCached } from "@/lib/usage/load";
import { parseTzOffset, rangeToJson, resolveRange } from "@/lib/usage/report";

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const tzOffsetMinutes = parseTzOffset(url.searchParams.get("tzOffset"));
  const userId = url.searchParams.get("userId") ?? undefined;
  const range = resolveRange({
    key: url.searchParams.get("range") ?? "all",
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    tzOffsetMinutes,
  });

  // Every id the money can be traced through, deleted keys included — their
  // ledger rows outlive the `api_keys` row, so a set built from the key list
  // alone under-reported the very spending this endpoint exists to report.
  const keyIds = await listAllApiKeyIdsForUsage({ userId });
  const report = await loadUsageReportCached({
    keyIds,
    tzOffsetMinutes,
    range,
    includeUsers: true,
  });

  return NextResponse.json({
    ok: true,
    data: {
      range: rangeToJson(report.range),
      // v1 compatibility.
      totals: report.summary,
      breakdown: report.series.map((point) => ({
        day: point.bucket,
        promptTokens: point.promptTokens,
        completionTokens: point.completionTokens,
        creditsUsed: point.creditsUsed,
        requests: point.requests,
      })),
      // Rich shape.
      summary: report.summary,
      series: report.series,
      byKey: report.byKey,
      byModel: report.byModel,
      byUser: report.byUser,
      byProvider: report.byProvider,
      // A subset of the figures above, for the web-search card. Not additive.
      webSearch: report.webSearch,
      truncatedKeys: report.truncatedKeys,
    },
  });
}
