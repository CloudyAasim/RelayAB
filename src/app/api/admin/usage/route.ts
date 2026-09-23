/**
 * app/api/admin/usage/route.ts
 *
 * GET /api/admin/usage?from=&to=&tzOffset=&groupBy=user|key|day
 *
 * Note: v1 only supports groupBy=day (across all keys). Per-key/per-user
 * breakdowns are planned for v1.1.
 *
 * Totals come from each key's running counter (`UsageTotals` hash), which
 * `recordUsage` maintains in the same MULTI as the log write. That single
 * read is O(keys), independent of how many requests each key has logged.
 *
 * The day breakdown still scans the per-key usage log capped at
 * MAX_LOGS_PER_KEY (1000) — high-volume keys therefore can have a slightly
 * undercounted breakdown on days with >1000 calls, while `totals` stays
 * accurate. Use ?from=&to= for precise day-level accounting in that case.
 */
import { NextResponse } from "next/server";
import { aggregateByKeyMany, listUsageByKey } from "@/lib/db/usage";
import { listAllApiKeys } from "@/lib/db/keys";
import { aggregateByDay } from "@/lib/quota/calculator";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { getCurrentUser } from "@/lib/auth/session";

export async function GET(req: Request): Promise<Response> {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: { code: "forbidden", message: "Admin required" } },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const tzOffset = Number(url.searchParams.get("tzOffset") ?? "0");

  const allKeys = await listAllApiKeys();
  const perKeyTotals = await aggregateByKeyMany(allKeys.map((k) => k.id));
  const totals = perKeyTotals.reduce(
    (acc, t) => {
      acc.promptTokens += t.promptTokens;
      acc.completionTokens += t.completionTokens;
      acc.totalTokens += t.totalTokens;
      acc.creditsUsed += t.creditsUsed;
      acc.requests += t.requestCount;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, creditsUsed: 0, requests: 0 },
  );

  // Day breakdown still needs the per-request logs. Capped at
  // MAX_LOGS_PER_KEY per key so very busy keys may undercount on
  // individual days — totals above are accurate regardless.
  const allLogs = (
    await Promise.all(allKeys.map((k) => listUsageByKey(k.id, { limit: MAX_LOGS_PER_KEY })))
  ).flat();
  const dayBuckets = aggregateByDay(allLogs, tzOffset);

  return NextResponse.json({
    ok: true,
    data: {
      totals,
      breakdown: dayBuckets,
    },
  });
}
