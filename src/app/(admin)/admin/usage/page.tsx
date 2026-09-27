import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/auth/session";
import { listAllApiKeys } from "@/lib/db/keys";
import { listUsers } from "@/lib/db/users";
import { getT } from "@/lib/i18n/server";
import { Card, CardHeader } from "@/components/ui/Card";
import { SectionPageLayout } from "@/components/layouts";
import { UsageScopePicker } from "@/components/usage/UsageScopePicker";
import { UsageViewTabs } from "@/components/usage/UsageViewTabs";
import { UsageAccountSummary } from "@/components/usage/UsageAccountSummary";
import { UsageBarChart } from "@/components/usage/UsageBarChart";
import {
  UsageBreakdownTable,
  type UsageBreakdownRow,
} from "@/components/usage/UsageBreakdownTable";
import {
  parseUsageMetric,
  resolveRange,
  sortByMetric,
  type UsageGroupRow,
} from "@/lib/usage/report";
import {
  loadUsageReportCached,
  sumAllTimeCached,
  type UsageReport,
} from "@/lib/usage/load";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { formatUserIdentity } from "@/lib/user-identity";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Coins, KeyRound, Users } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;
const BASE_PATH = "/admin/usage";

type Scope = "all" | "key" | "model";
type Group = "user" | "key" | "model";

function parseGroup(value: string | undefined): Group {
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

  const range = resolveRange({
    key: first(sp.range),
    tzOffsetMinutes: TZ_OFFSET_MINUTES,
  });
  const metric = parseUsageMetric(first(sp.metric));
  const group = parseGroup(first(sp.group));
  const requestedScope = first(sp.scope);
  const scope: Scope =
    requestedScope === "key" || requestedScope === "model" ? requestedScope : "all";

  const [{ t }, allKeys, userPage] = await Promise.all([
    getT(),
    listAllApiKeys(),
    listUsers({ limit: 200 }),
  ]);
  const users = userPage.users;
  const universeIds = allKeys.map((key) => key.id);

  const requestedKeyId = first(sp.keyId);
  const requestedModel = first(sp.model);
  const effectiveKeyId =
    scope === "key"
      ? allKeys.find((key) => key.id === requestedKeyId)?.id ?? allKeys[0]?.id
      : undefined;
  const effectiveModel = scope === "model" ? requestedModel : undefined;

  let report: UsageReport;
  let modelOptionRows: UsageGroupRow[];

  if (scope === "key" && effectiveKeyId) {
    report = await loadUsageReportCached({
      keyIds: [effectiveKeyId],
      tzOffsetMinutes: TZ_OFFSET_MINUTES,
      range,
      includeUsers: true,
    });
    modelOptionRows = report.byModel;
  } else if (scope === "model" && effectiveModel) {
    const universeReport = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: TZ_OFFSET_MINUTES,
      range,
      includeUsers: true,
    });
    report = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: TZ_OFFSET_MINUTES,
      range,
      model: effectiveModel,
      includeUsers: true,
    });
    modelOptionRows = universeReport.byModel;
  } else {
    report = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: TZ_OFFSET_MINUTES,
      range,
      includeUsers: true,
    });
    modelOptionRows = report.byModel;
  }

  const lifetime = await sumAllTimeCached(universeIds);

  const userLabel = (id: string) => {
    const user = users.find((candidate) => candidate.id === id);
    return user ? formatUserIdentity(user.username, user.displayName) : id;
  };
  const keyById = new Map(allKeys.map((key) => [key.id, key]));

  const labels = {
    credits: t("usage.table.credits"),
    tokens: t("usage.table.tokens"),
    requests: t("usage.table.requests"),
  };
  const headers = {
    item: t("usage.table.item"),
    requests: t("usage.table.requests"),
    tokens: t("usage.table.tokens"),
    credits: t("usage.table.credits"),
    actions: t("usage.table.actions"),
  };
  const rangeOptions = [
    { value: "today", label: t("usage.range.today") },
    { value: "7d", label: t("usage.range.7d") },
    { value: "30d", label: t("usage.range.30d") },
    { value: "all", label: t("usage.range.all") },
  ];
  const rangeLabel =
    rangeOptions.find((option) => option.value === range.key)?.label ?? range.key;

  const sourceRows =
    group === "user" ? report.byUser : group === "model" ? report.byModel : report.byKey;
  const rows: UsageBreakdownRow[] = sortByMetric(
    sourceRows.map((row) => {
      if (group === "user") return { ...row, label: userLabel(row.id) };
      if (group === "model") return { ...row, label: row.id };
      const key = keyById.get(row.id);
      return { ...row, label: key?.label ?? row.id, sublabel: key?.keyPrefix };
    }),
    metric,
  );

  const metricLabel = t(`usage.table.${metric}`);
  const groupOptions: Array<{ value: string; label: string }> = [
    { value: "user", label: t("usage.breakdown.byUser") },
    { value: "key", label: t("usage.breakdown.byKey") },
    { value: "model", label: t("usage.breakdown.byModel") },
  ];
  const scopeParams =
    scope === "key"
      ? { scope: "key", keyId: effectiveKeyId }
      : scope === "model"
        ? { scope: "model", model: effectiveModel }
        : { scope: "all" };

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("usage.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className="mb-4 text-xs text-muted-foreground">{t("usage.tzNote")}</p>

        <UsageAccountSummary
          figures={[
            {
              label: t("usage.stat.used"),
              value: formatCredits(lifetime.creditsUsed),
              hint: `${formatNumber(lifetime.totalTokens)} ${labels.tokens}`,
              icon: <Coins className="h-4 w-4" />,
              tone: "orange",
            },
            {
              label: t("admin.stat.users"),
              value: formatNumber(users.length),
              icon: <Users className="h-4 w-4" />,
              tone: "primary",
            },
            {
              label: t("usage.stat.activeKeys"),
              value: formatNumber(allKeys.filter((key) => key.enabled).length),
              icon: <KeyRound className="h-4 w-4" />,
              tone: "neutral",
            },
          ]}
        />

        <Card className="mb-4 space-y-3 sm:mb-6">
          <UsageScopePicker
            basePath={BASE_PATH}
            params={{ range: range.key, metric, group }}
            scope={scope}
            keyId={effectiveKeyId}
            model={effectiveModel}
            keys={allKeys.map((key) => ({
              value: key.id,
              label: `${userLabel(key.userId)} · ${key.label} · ${key.keyPrefix}`,
            }))}
            models={modelOptionRows.map((row) => ({ value: row.id, label: row.id }))}
            labels={{
              scope: t("usage.scope.label"),
              all: t("usage.scope.all"),
              key: t("usage.scope.key"),
              model: t("usage.scope.model"),
              keyPlaceholder: t("usage.scope.keyPlaceholder"),
              modelPlaceholder: t("usage.scope.modelPlaceholder"),
              apply: t("usage.scope.apply"),
            }}
          />
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <UsageViewTabs
              basePath={BASE_PATH}
              params={{ ...scopeParams, metric, group }}
              param="range"
              active={range.key}
              label={t("usage.range.label")}
              options={rangeOptions}
            />
            <UsageViewTabs
              basePath={BASE_PATH}
              params={{ ...scopeParams, range: range.key, group }}
              param="metric"
              active={metric}
              label={t("usage.view.metric")}
              options={[
                { value: "credits", label: labels.credits },
                { value: "tokens", label: labels.tokens },
                { value: "requests", label: labels.requests },
              ]}
            />
            <UsageViewTabs
              basePath={BASE_PATH}
              params={{ ...scopeParams, range: range.key, metric }}
              param="group"
              active={group}
              label={t("usage.group.label")}
              options={groupOptions}
            />
          </div>
        </Card>

        <Card className="mt-4 sm:mt-6">
          <CardHeader title={t("usage.chart.title")} description={rangeLabel} />
          <UsageBarChart
            points={report.series}
            grain={range.grain}
            metric={metric}
            metricLabel={metricLabel}
            summary={report.summary}
            labels={labels}
            emptyLabel={t("usage.empty")}
          />
        </Card>

        {report.truncatedKeys > 0 && (
          <p className="mt-3 text-xs text-warning">
            {t("usage.truncated", { max: MAX_LOGS_PER_KEY })}
          </p>
        )}

        <Card className="mt-4 sm:mt-6">
          <CardHeader title={t("usage.breakdown.title")} description={rangeLabel} />
          <UsageBreakdownTable
            rows={rows}
            headers={headers}
            emphasis={metric}
            emptyLabel={t("usage.empty")}
          />
        </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
