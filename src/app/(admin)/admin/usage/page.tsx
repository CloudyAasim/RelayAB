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
import { UsageBarChart } from "@/components/usage/UsageBarChart";
import {
  UsageBreakdownTable,
  type UsageBreakdownRow,
} from "@/components/usage/UsageBreakdownTable";
import { resolveRange } from "@/lib/usage/report";
import { loadUsageReportCached } from "@/lib/usage/load";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { formatUserIdentity } from "@/lib/user-identity";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Activity, Coins, KeyRound } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;

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

  const rangeParam = `range=${encodeURIComponent(range.key)}`;
  const userRows: UsageBreakdownRow[] = report.byUser.map((row) => ({
    ...row,
    label: userLabel(row.id),
    href: `/admin/usage?${rangeParam}&userId=${encodeURIComponent(row.id)}`,
  }));
  const keyRows: UsageBreakdownRow[] = report.byKey.map((row) => {
    const key = keyById.get(row.id);
    return {
      ...row,
      label: key?.label ?? row.id,
      sublabel: key?.keyPrefix,
    };
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

        {userId && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <span>{t("usage.filteredBy", { name: userLabel(userId) })}</span>
            <Link
              href={`/admin/usage?${rangeParam}`}
              className="text-primary hover:underline"
            >
              {t("usage.clearFilter")}
            </Link>
          </div>
        )}

        <Card className="mb-4 sm:mb-6">
          <UsageRangePicker
            active={range.key}
            from={first(sp.from)}
            to={first(sp.to)}
            keep={{ userId }}
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

        <div className="mt-4 space-y-4 sm:mt-6 sm:space-y-6">
          <Card>
            <CardHeader title={t("usage.breakdown.byUser")} />
            <UsageBreakdownTable
              rows={userRows}
              headers={headers}
              emptyLabel={t("usage.empty")}
              detailLabel={t("usage.viewUser")}
            />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title={t("usage.breakdown.byKey")} />
              <UsageBreakdownTable rows={keyRows} headers={headers} emptyLabel={t("usage.empty")} />
            </Card>
            <Card>
              <CardHeader title={t("usage.breakdown.byModel")} />
              <UsageBreakdownTable rows={modelRows} headers={headers} emptyLabel={t("usage.empty")} />
            </Card>
          </div>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
