import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listAllApiKeys } from "@/lib/db/keys";
import { listUsers } from "@/lib/db/users";
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
import { formatUserIdentity } from "@/lib/user-identity";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Activity, Coins, KeyRound } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;
const BASE_PATH = "/admin/usage";
const DIMENSIONS = ["user", "key", "model"] as const;
type Dimension = (typeof DIMENSIONS)[number];

function parseDimension(value: string | undefined): Dimension {
  return value === "key" || value === "model" || value === "user" ? value : "user";
}

interface UsagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminUsagePage({ searchParams }: UsagePageProps) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/dashboard");

  const sp = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined;
  const userId = first(sp.userId);
  const dimension = parseDimension(first(sp.dimension));
  const metric = parseUsageMetric(first(sp.metric));

  const range = resolveRange({
    key: first(sp.range),
    from: first(sp.from),
    to: first(sp.to),
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
  });

  const [{ t }, allKeys, userPage] = await Promise.all([
    getT(),
    listAllApiKeys(),
    listUsers({ limit: 200 }),
  ]);
  const users = userPage.users;
  const keys = userId ? allKeys.filter((key) => key.userId === userId) : allKeys;

  const report = await loadUsageReportCached({
    keyIds: keys.map((key) => key.id),
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
    range,
    includeUsers: true,
  });

  const userLabel = (id: string) => {
    const user = users.find((candidate) => candidate.id === id);
    return user ? formatUserIdentity(user.username, user.displayName) : id;
  };
  const keyById = new Map(keys.map((key) => [key.id, key]));

  const headers = {
    item: t("usage.table.item"),
    requests: t("usage.table.requests"),
    tokens: t("usage.table.tokens"),
    credits: t("usage.table.credits"),
    actions: t("usage.table.actions"),
  };

  const baseParams = {
    range: first(sp.range),
    from: first(sp.from),
    to: first(sp.to),
    userId,
    dimension,
    metric,
  };

  const rows: UsageBreakdownRow[] = sortByMetric(
    (() => {
      if (dimension === "key") {
        return report.byKey.map((row) => {
          const key = keyById.get(row.id);
          return { ...row, label: key?.label ?? row.id, sublabel: key?.keyPrefix };
        });
      }
      if (dimension === "model") {
        return report.byModel.map((row) => ({ ...row, label: row.id }));
      }
      const rangeParam = `range=${encodeURIComponent(range.key)}`;
      return report.byUser.map((row) => ({
        ...row,
        label: userLabel(row.id),
        href: `${BASE_PATH}?${rangeParam}&dimension=user&metric=${metric}&userId=${encodeURIComponent(
          row.id,
        )}`,
      }));
    })(),
    metric,
  );

  const metricLabel = t(`usage.table.${metric}`);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("usage.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className="mb-4 text-xs text-muted-foreground">{t("usage.tzNote")}</p>

        {userId && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <span>{t("usage.filteredBy", { name: userLabel(userId) })}</span>
            <Link
              href={`${BASE_PATH}?range=${encodeURIComponent(range.key)}&dimension=${dimension}&metric=${metric}`}
              className="text-primary hover:underline"
            >
              {t("usage.clearFilter")}
            </Link>
          </div>
        )}

        <Card className="mb-4 space-y-3 sm:mb-6">
          <UsageRangePicker
            active={range.key}
            from={first(sp.from)}
            to={first(sp.to)}
            keep={{ userId, dimension, metric }}
          />
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <UsageViewTabs
              basePath={BASE_PATH}
              params={baseParams}
              param="dimension"
              active={dimension}
              label={t("usage.view.dimension")}
              options={[
                { value: "user", label: t("usage.breakdown.byUser") },
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
            label={t("usage.stat.activeKeys")}
            value={formatNumber(keys.filter((key) => key.enabled).length)}
            icon={<KeyRound className="h-4 w-4" />}
            tone="neutral"
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
            detailLabel={dimension === "user" ? t("usage.viewUser") : undefined}
          />
        </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
