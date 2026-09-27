import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { listApiKeysByUser } from "@/lib/db/keys";
import { getT } from "@/lib/i18n/server";
import { Card, CardHeader, StatCard } from "@/components/ui/Card";
import { SectionPageLayout } from "@/components/layouts";
import { UsageRangePicker } from "@/components/usage/UsageRangePicker";
import { UsageViewTabs } from "@/components/usage/UsageViewTabs";
import { UsageBarChart } from "@/components/usage/UsageBarChart";
import {
  UsageBreakdownTable,
  type UsageBreakdownRow,
} from "@/components/usage/UsageBreakdownTable";
import { parseUsageMetric, resolveRange, sortByMetric } from "@/lib/usage/report";
import { loadUsageReportCached } from "@/lib/usage/load";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Activity, Coins, KeyRound, Wallet } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;
const BASE_PATH = "/dashboard/usage";

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
  const metric = parseUsageMetric(first(sp.metric));
  const dimension = first(sp.dimension) === "model" ? "model" : "key";

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

  const sourceRows = dimension === "model" ? report.byModel : report.byKey;
  const rows: UsageBreakdownRow[] = sortByMetric(
    sourceRows.map((row) => {
      if (dimension === "model") return { ...row, label: row.id };
      const key = keys.find((candidate) => candidate.id === row.id);
      return { ...row, label: key?.label ?? row.id, sublabel: key?.keyPrefix };
    }),
    metric,
  );

  const metricLabel = t(`usage.table.${metric}`);
  const baseParams = {
    range: first(sp.range),
    from: first(sp.from),
    to: first(sp.to),
    dimension,
    metric,
  };

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("usage.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className="mb-4 text-xs text-muted-foreground">{t("usage.tzNote")}</p>

        <Card className="mb-4 space-y-3 sm:mb-6">
          <UsageRangePicker
            active={range.key}
            from={first(sp.from)}
            to={first(sp.to)}
            keep={{ dimension, metric }}
          />
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <UsageViewTabs
              basePath={BASE_PATH}
              params={baseParams}
              param="dimension"
              active={dimension}
              label={t("usage.view.dimension")}
              options={[
                { value: "key", label: t("usage.breakdown.byKey") },
                { value: "model", label: t("usage.breakdown.byModel") },
              ]}
            />
            <UsageViewTabs
              basePath={BASE_PATH}
              params={baseParams}
              param="metric"
              active={metric}
              label={t("usage.view.metric")}
              options={[
                { value: "credits", label: t("usage.table.credits") },
                { value: "tokens", label: t("usage.table.tokens") },
                { value: "requests", label: t("usage.table.requests") },
              ]}
            />
          </div>
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
            metric={metric}
            metricLabel={metricLabel}
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

        <Card className="mt-4 sm:mt-6">
          <CardHeader title={t("usage.breakdown.title")} />
          <UsageBreakdownTable
            rows={rows}
            headers={headers}
            emphasis={metric}
            emptyLabel={t("usage.empty")}
          />
        </Card>

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
