import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { listApiKeysByUser } from "@/lib/db/keys";
import { getT } from "@/lib/i18n/server";
import { Card, CardHeader, StatCard } from "@/components/ui/Card";
import { SectionPageLayout } from "@/components/layouts";
import { UsageRangePicker } from "@/components/usage/UsageRangePicker";
import { UsageBarChart } from "@/components/usage/UsageBarChart";
import {
  UsageBreakdownTable,
  type UsageBreakdownRow,
} from "@/components/usage/UsageBreakdownTable";
import { resolveRange } from "@/lib/usage/report";
import { loadUsageReportCached } from "@/lib/usage/load";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Activity, Coins, KeyRound, Wallet } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;

interface UsagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsagePage({ searchParams }: UsagePageProps) {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const sp = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined;

  const range = resolveRange({
    key: first(sp.range),
    from: first(sp.from),
    to: first(sp.to),
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
  });

  const [{ t }, fullUser, keyPage] = await Promise.all([
    getT(),
    getUserById(sessionUser.id),
    listApiKeysByUser(sessionUser.id, { limit: 200 }),
  ]);
  const keys = keyPage.keys;
  const report = await loadUsageReportCached({
    keyIds: keys.map((key) => key.id),
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
    range,
  });

  const quotaType = fullUser?.quotaType ?? "credits";
  const quotaLimit = fullUser?.quotaLimit ?? 0;
  const quotaUsed = fullUser?.quotaUsed ?? 0;
  const neverGranted = quotaLimit === 0;
  const remaining = Math.max(0, quotaLimit - quotaUsed);

  const unitLabel = t(`admin.keys.create.quotaType.${quotaType}`);
  const fmtQuota = (n: number) =>
    quotaType === "tokens"
      ? `${formatNumber(n)} ${unitLabel}`
      : `${formatCredits(n)} ${unitLabel}`;

  const headers = {
    item: t("usage.table.item"),
    requests: t("usage.table.requests"),
    tokens: t("usage.table.tokens"),
    credits: t("usage.table.credits"),
    actions: t("usage.table.actions"),
  };

  const keyRows: UsageBreakdownRow[] = report.byKey.map((row) => {
    const key = keys.find((candidate) => candidate.id === row.id);
    return { ...row, label: key?.label ?? row.id, sublabel: key?.keyPrefix };
  });
  const modelRows: UsageBreakdownRow[] = report.byModel.map((row) => ({
    ...row,
    label: row.id,
  }));

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("usage.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className="mb-4 text-xs text-muted-foreground">{t("usage.tzNote")}</p>

        <Card className="mb-4 sm:mb-6">
          <UsageRangePicker
            active={range.key}
            from={first(sp.from)}
            to={first(sp.to)}
          />
        </Card>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={t("usage.stat.requests")}
            value={formatNumber(report.summary.requests)}
            icon={<Activity className="h-4 w-4" />}
            tone="info"
          />
          <StatCard
            label={t("usage.stat.tokens")}
            value={formatNumber(report.summary.totalTokens)}
            icon={<Activity className="h-4 w-4" />}
            tone="primary"
          />
          <StatCard
            label={t("usage.stat.credits")}
            value={formatCredits(report.summary.creditsUsed)}
            icon={<Coins className="h-4 w-4" />}
            tone="orange"
          />
          <StatCard
            label={t("usage.stat.balance")}
            value={neverGranted ? t("dashboard.pool.none") : fmtQuota(remaining)}
            icon={<Wallet className="h-4 w-4" />}
            tone="success"
            hint={
              neverGranted
                ? undefined
                : t("usage.stat.balanceHint", { limit: fmtQuota(quotaLimit) })
            }
          />
        </div>

        <Card className="mt-4 sm:mt-6">
          <CardHeader
            title={t("usage.chart.title")}
            description={t("usage.chart.description")}
          />
          <UsageBarChart
            points={report.series}
            grain={range.grain}
            labels={{
              credits: t("usage.table.credits"),
              tokens: t("usage.table.tokens"),
              requests: t("usage.table.requests"),
            }}
            emptyLabel={t("usage.empty")}
          />
        </Card>

        {report.truncatedKeys > 0 && (
          <p className="mt-3 text-xs text-warning">
            {t("usage.truncated", { max: MAX_LOGS_PER_KEY })}
          </p>
        )}

        <div className="mt-4 grid gap-4 sm:mt-6 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("usage.breakdown.byKey")} />
            <UsageBreakdownTable rows={keyRows} headers={headers} emptyLabel={t("usage.empty")} />
          </Card>
          <Card>
            <CardHeader title={t("usage.breakdown.byModel")} />
            <UsageBreakdownTable rows={modelRows} headers={headers} emptyLabel={t("usage.empty")} />
          </Card>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:mt-6 sm:grid-cols-2">
          <StatCard
            label={t("usage.stat.used")}
            value={neverGranted ? "—" : fmtQuota(quotaUsed)}
            icon={<Coins className="h-4 w-4" />}
            tone="neutral"
          />
          <StatCard
            label={t("usage.stat.activeKeys")}
            value={formatNumber(keys.filter((key) => key.enabled).length)}
            icon={<KeyRound className="h-4 w-4" />}
            tone="neutral"
          />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
