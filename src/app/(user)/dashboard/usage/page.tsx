import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { listApiKeysByUser } from "@/lib/db/keys";
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
import { loadUsageReportCached, type UsageReport } from "@/lib/usage/load";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { formatCredits, formatNumber } from "@/lib/utils";
import { Coins, KeyRound, Wallet } from "lucide-react";

/** All dates on this screen are bucketed in GMT+8. */
const TZ_OFFSET_MINUTES = 480;
const BASE_PATH = "/dashboard/usage";

type Scope = "all" | "key" | "model";

interface UsagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsagePage({ searchParams }: UsagePageProps) {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const sp = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined;

  // The page is built around two fixed windows: last 7 days and last 1 day.
  // Computed per request — a module-level constant would freeze at boot.
  const range7 = resolveRange({ key: "7d", tzOffsetMinutes: TZ_OFFSET_MINUTES });
  const range1 = resolveRange({ key: "today", tzOffsetMinutes: TZ_OFFSET_MINUTES });

  const metric = parseUsageMetric(first(sp.metric));
  const group = first(sp.group) === "model" ? "model" : "key";
  const requestedScope = first(sp.scope);
  const scope: Scope =
    requestedScope === "key" || requestedScope === "model" ? requestedScope : "all";

  const [{ t }, fullUser, keyPage] = await Promise.all([
    getT(),
    getUserById(sessionUser.id),
    listApiKeysByUser(sessionUser.id, { limit: 200 }),
  ]);
  const keys = keyPage.keys;
  const universeIds = keys.map((key) => key.id);

  // Resolve the requested scope against what actually exists.
  const requestedKeyId = first(sp.keyId);
  const requestedModel = first(sp.model);
  const effectiveKeyId =
    scope === "key"
      ? keys.find((key) => key.id === requestedKeyId)?.id ?? keys[0]?.id
      : undefined;
  const effectiveModel = scope === "model" ? requestedModel : undefined;

  let report7: UsageReport;
  let report1: UsageReport;
  let modelOptionRows: UsageGroupRow[];

  if (scope === "key" && effectiveKeyId) {
    [report7, report1] = await Promise.all([
      loadUsageReportCached({ keyIds: [effectiveKeyId], tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range7 }),
      loadUsageReportCached({ keyIds: [effectiveKeyId], tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range1 }),
    ]);
    modelOptionRows = report7.byModel;
  } else if (scope === "model" && effectiveModel) {
    const universe7 = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: TZ_OFFSET_MINUTES,
      range: range7,
    });
    [report7, report1] = await Promise.all([
      loadUsageReportCached({ keyIds: universeIds, tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range7, model: effectiveModel }),
      loadUsageReportCached({ keyIds: universeIds, tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range1, model: effectiveModel }),
    ]);
    modelOptionRows = universe7.byModel;
  } else {
    [report7, report1] = await Promise.all([
      loadUsageReportCached({ keyIds: universeIds, tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range7 }),
      loadUsageReportCached({ keyIds: universeIds, tzOffsetMinutes: TZ_OFFSET_MINUTES, range: range1 }),
    ]);
    modelOptionRows = report7.byModel;
  }

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

  const sourceRows = group === "model" ? report7.byModel : report7.byKey;
  const rows: UsageBreakdownRow[] = sortByMetric(
    sourceRows.map((row) => {
      if (group === "model") return { ...row, label: row.id };
      const key = keys.find((candidate) => candidate.id === row.id);
      return { ...row, label: key?.label ?? row.id, sublabel: key?.keyPrefix };
    }),
    metric,
  );

  const metricLabel = t(`usage.table.${metric}`);
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
              label: t("usage.stat.balance"),
              value: neverGranted ? t("dashboard.pool.none") : fmtQuota(remaining),
              hint: neverGranted
                ? undefined
                : t("usage.stat.balanceHint", { limit: fmtQuota(quotaLimit) }),
              icon: <Wallet className="h-4 w-4" />,
              tone: "success",
            },
            {
              label: t("usage.stat.used"),
              value: neverGranted ? "—" : fmtQuota(quotaUsed),
              icon: <Coins className="h-4 w-4" />,
              tone: "orange",
            },
            {
              label: t("usage.stat.activeKeys"),
              value: formatNumber(keys.filter((key) => key.enabled).length),
              icon: <KeyRound className="h-4 w-4" />,
              tone: "neutral",
            },
          ]}
          progress={
            neverGranted
              ? undefined
              : {
                  percent: quotaLimit > 0 ? (quotaUsed / quotaLimit) * 100 : 0,
                  caption: t("dashboard.pool.sharedByKeys"),
                  exhausted: quotaUsed >= quotaLimit,
                }
          }
        />

        <Card className="mb-4 space-y-3 sm:mb-6">
          <UsageScopePicker
            basePath={BASE_PATH}
            params={{ metric, group }}
            scope={scope}
            keyId={effectiveKeyId}
            model={effectiveModel}
            keys={keys.map((key) => ({
              value: key.id,
              label: `${key.label} · ${key.keyPrefix}`,
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
              params={{ ...scopeParams, group }}
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
              params={{ ...scopeParams, metric }}
              param="group"
              active={group}
              label={t("usage.group.label")}
              options={[
                { value: "key", label: t("usage.breakdown.byKey") },
                { value: "model", label: t("usage.breakdown.byModel") },
              ]}
            />
          </div>
        </Card>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title={t("usage.chart.last7")} />
            <UsageBarChart
              points={report7.series}
              grain={range7.grain}
              metric={metric}
              metricLabel={metricLabel}
              summary={report7.summary}
              labels={labels}
              emptyLabel={t("usage.empty")}
            />
          </Card>
          <Card>
            <CardHeader title={t("usage.chart.last1")} />
            <UsageBarChart
              points={report1.series}
              grain={range1.grain}
              metric={metric}
              metricLabel={metricLabel}
              summary={report1.summary}
              labels={labels}
              emptyLabel={t("usage.empty")}
            />
          </Card>
        </div>

        {report7.truncatedKeys > 0 && (
          <p className="mt-3 text-xs text-warning">
            {t("usage.truncated", { max: MAX_LOGS_PER_KEY })}
          </p>
        )}

        <Card className="mt-4 sm:mt-6">
          <CardHeader title={t("usage.breakdown.title")} description={t("usage.chart.last7")} />
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
