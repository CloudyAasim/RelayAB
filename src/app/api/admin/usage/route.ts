/**
 * app/api/admin/usage/route.ts
 *
 * GET /api/admin/usage?from=&to=&tzOffset=&groupBy=user|key|day
 *
 * Note: v1 only supports groupBy=day (across all keys). Per-key/per-user
 * breakdowns are planned for v1.1.
 */
import { NextResponse } from "next/server";
import { listUsageByKey } from "@/lib/db/usage";
import { listAllApiKeys } from "@/lib/db/keys";
import { aggregateByDay } from "@/lib/quota/calculator";
import type { UsageLog } from "@/lib/db/types";
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
  const allLogs = (
    await Promise.all(allKeys.map((k) => listUsageByKey(k.id, { limit: 1000 })))
  ).flat();

  const dayBuckets = aggregateByDay(allLogs, tzOffset);

  const totals = allLogs.reduce(
    (acc, l) => {
      if (l.status !== "success") return acc;
      acc.promptTokens += l.promptTokens;
      acc.completionTokens += l.completionTokens;
      acc.totalTokens += l.totalTokens;
      acc.creditsUsed += l.creditsUsed;
      acc.requests += 1;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, creditsUsed: 0, requests: 0 },
  );

  return NextResponse.json({
    ok: true,
    data: {
      totals,
      breakdown: dayBuckets,
    },
  });
}
