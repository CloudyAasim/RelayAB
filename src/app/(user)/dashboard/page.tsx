import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";
import { Card, StatCard, CardHeader } from "@/components/ui/Card";
import { KeyStatusBadge } from "@/components/keys/KeyStatusBadge";
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from "@/components/ui/Table";
import { formatCredits, formatNumber, formatDate, cn } from "@/lib/utils";
import { timezoneToIana, timezoneLabelKey, timezoneOffsetMinutes } from "@/lib/timezone";
import { getT } from "@/lib/i18n/server";
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { groupModelsByKind, type ModelGroup } from "@/lib/admin/model-groups";
import { listApiKeyIdsForUsage } from "@/lib/db/keys";
import { MAX_LOGS_PER_KEY } from "@/lib/db/usage";
import { SectionPageLayout } from "@/components/layouts";
import { UsageScopePicker } from "@/components/usage/UsageScopePicker";
import { UsageViewTabs } from "@/components/usage/UsageViewTabs";
import { UsageWebSearchCard } from "@/components/usage/UsageWebSearchCard";
import { UsageBarChart } from "@/components/usage/UsageBarChart";
import {
  UsageBreakdownTable,
  type UsageBreakdownRow,
} from "@/components/usage/UsageBreakdownTable";
import {
  parseUsageMetric,
  resolveRange,
  sortByMetric,
  cacheHitRate,
  formatUsageMetric,
  usagePace,
  type UsageGroupRow,
} from "@/lib/usage/report";
import { loadUsageReportCached, type UsageReport } from "@/lib/usage/load";
import {
  CreateKeyButton,
  type UserAllocation,
} from "./CreateKeyButton";
import { UserKeyActions } from "./UserKeyActions";
import { AllocationSummary } from "./AllocationSummary";
import { Coins, Activity, Sparkles, Database } from "lucide-react";
import {
  cachedGetUserById,
  cachedListApiKeysByUser,
  cachedAggregateByUser,
} from "@/lib/db/data-cache";

const BASE_PATH = "/dashboard";

type Scope = "all" | "key" | "model";

interface DashboardPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The whole account in one page: allocation, keys, and usage.
 *
 * "How much have I left?", "which keys do I have?" and "where did it go?" are
 * asked one after another about the same account, so they are answered on the
 * same screen. The usage view used to live at `/dashboard/usage`, which meant
 * opening a second page to answer the question the balance panel had just
 * raised.
 */
export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  // Usage buckets in the reader's own display timezone; everything else on the
  // page formats dates with the same zone.
  const timeZone = timezoneToIana(sessionUser.timezone);
  const tzOffsetMinutes = timezoneOffsetMinutes(sessionUser.timezone);

  const sp = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined;

  const range = resolveRange({ key: first(sp.range), tzOffsetMinutes });
  const metric = parseUsageMetric(first(sp.metric));
  const group = first(sp.group) === "model" ? "model" : "key";
  const requestedScope = first(sp.scope);
  const scope: Scope =
    requestedScope === "key" || requestedScope === "model" ? requestedScope : "all";

  const [{ t }, fullUser, keyPage, usageKeyIds] = await Promise.all([
    getT(),
    cachedGetUserById(sessionUser.id),
    cachedListApiKeysByUser(sessionUser.id, 200),
    listApiKeyIdsForUsage(sessionUser.id),
  ]);
  const keys = keyPage.keys;
  const agg = await cachedAggregateByUser(keys.map((k) => k.id));

  // The whitelist is shown grouped by kind, which needs the catalogue. An
  // account on "every model" has no list to group, so it skips the query
  // entirely rather than paying for two provider reads it will not render.
  let modelGroups: ModelGroup[] = [];
  if (fullUser && fullUser.allowedModels.length > 0) {
    const [providers, mediaProviders] = await Promise.all([
      listProviders({ enabledOnly: true }),
      listMediaProviders({ enabledOnly: true }),
    ]);
    modelGroups = groupModelsByKind(providers, mediaProviders);
  }

  const allocation: UserAllocation | null = fullUser
    ? {
        maxActiveKeys: fullUser.maxActiveKeys,
        activeKeyCount: keys.filter((k) => k.enabled).length,
        allowedModels: fullUser.allowedModels,
      }
    : null;

  /**
   * The scope picker offers the keys this person can actually use. The report
   * covers every key their balance can be charged through — the assistant
   * credential included, because `settleUsage` draws its calls from the same
   * pool. Deriving both from one list is what left the assistant's spending
   * taken from the balance and absent from the page that reports the balance.
   */
  const universeIds = usageKeyIds;

  const requestedKeyId = first(sp.keyId);
  const requestedModel = first(sp.model);
  const effectiveKeyId =
    scope === "key"
      ? keys.find((key) => key.id === requestedKeyId)?.id ?? keys[0]?.id
      : undefined;
  const effectiveModel = scope === "model" ? requestedModel : undefined;

  let report: UsageReport;
  let modelOptionRows: UsageGroupRow[];

  if (scope === "key" && effectiveKeyId) {
    report = await loadUsageReportCached({
      keyIds: [effectiveKeyId],
      tzOffsetMinutes: tzOffsetMinutes,
      range,
    });
    modelOptionRows = report.byModel;
  } else if (scope === "model" && effectiveModel) {
    const universeReport = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: tzOffsetMinutes,
      range,
    });
    report = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: tzOffsetMinutes,
      range,
      model: effectiveModel,
    });
    modelOptionRows = universeReport.byModel;
  } else {
    report = await loadUsageReportCached({
      keyIds: universeIds,
      tzOffsetMinutes: tzOffsetMinutes,
      range,
    });
    modelOptionRows = report.byModel;
  }

  /** The pace over the selected range: the average per bucket, and the peak. */
  const pace = usagePace(report.series, metric);

  const labels = {
    credits: t("usage.table.credits"),
    tokens: t("usage.table.tokens"),
    requests: t("usage.table.requests"),
    images: t("usage.table.images"),
  };
  const headers = {
    item: t("usage.table.item"),
    requests: t("usage.table.requests"),
    tokens: t("usage.table.tokens"),
    credits: t("usage.table.credits"),
    images: t("usage.table.images"),
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

  const sourceRows = group === "model" ? report.byModel : report.byKey;
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
      <SectionPageLayout.Title>
        {t("dashboard.welcome", { name: fullUser?.displayName ?? sessionUser.username })}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CreateKeyButton allocation={allocation} />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {/*
          One rhythm for the whole page: every block below is a section of its
          own, separated by the same 16px, so the page reads as a stack of
          titled cards rather than as a pile of boxes that happen to touch.
        */}
        <div className="space-y-4">
          {/*
            Balance, spend and the whitelist come from one panel. The usage page
            used to repeat the balance and the active-key count in its own
            summary card, and the dashboard repeated the count again as a stat
            tile — the same three facts, three times, on one screen.
          */}
          {fullUser && (
            <AllocationSummary
              quotaType={fullUser.quotaType}
              quotaLimit={fullUser.quotaLimit}
              quotaUsed={fullUser.quotaUsed}
              allowedModels={fullUser.allowedModels}
              modelGroups={modelGroups}
              maxActiveKeys={fullUser.maxActiveKeys}
              activeKeyCount={keys.filter((k) => k.enabled).length}
            />
          )}

          {/*
            Lifetime totals only: the balance above is the quota figure, so a
            "keys" tile and a second "used" tile would restate the panel.
          */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <StatCard
              label={t("dashboard.stat.tokensUsed")}
              value={formatNumber(agg.totalTokens)}
              icon={<Activity className="h-4 w-4" />}
              tone="info"
            />
            <StatCard
              label={t("dashboard.stat.creditsUsed")}
              value={formatCredits(agg.creditsUsed)}
              icon={<Coins className="h-4 w-4" />}
              tone="orange"
            />
          </div>

          {/* API Keys list */}
          <Card padded={false} className="p-3 sm:p-4">
            <CardHeader title={t("dashboard.apiKeys.title")} />
            {keys.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="h-5 w-5" />}
                title={t("dashboard.apiKeys.empty.title")}
              />
            ) : (
              <div className="overflow-x-auto -mx-3 sm:mx-0">
                <Table bare>
                  <THead>
                    <TR>
                      <TH className="whitespace-nowrap">{t("admin.keys.create.label")}</TH>
                      <TH className="whitespace-nowrap">{t("dashboard.table.key")}</TH>
                      <TH className="hidden md:table-cell whitespace-nowrap">{t("dashboard.table.modelScope")}</TH>
                      <TH className="hidden lg:table-cell whitespace-nowrap">{t("dashboard.table.lastUsed")}</TH>
                      <TH className="hidden xl:table-cell whitespace-nowrap">{t("admin.keys.create.expiresAt")}</TH>
                      <TH className="whitespace-nowrap text-center">{t("dashboard.table.status")}</TH>
                      <TH className="whitespace-nowrap text-right">{t("common.actions")}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {keys.map((k) => (
                      <TR key={k.id}>
                        <TD className="font-medium">{k.label}</TD>
                        <TD>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {k.keyPrefix}
                          </code>
                        </TD>
                        <TD className="hidden md:table-cell text-muted-foreground">
                          {k.allowedModels.length > 0
                            ? k.allowedModels.join(", ")
                            : t("dashboard.table.inheritsAccount")}
                        </TD>
                        <TD className="hidden lg:table-cell text-muted-foreground">
                          {formatDate(k.lastUsedAt, timeZone)}
                        </TD>
                        <TD className="hidden xl:table-cell text-muted-foreground">
                          {formatDate(k.expiresAt, timeZone)}
                        </TD>
                        <TD className="text-center">
                          {/* The status, once. It used to be a bare dot here
                              and a badge in the actions cell — the same fact
                              twice in one row, and the two disagreed about a
                              key that was switched off or forced off. */}
                          <KeyStatusBadge apiKey={k} />
                        </TD>
                        <TD className="text-right">
                          <UserKeyActions apiKey={k} timeZone={timeZone} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>

          {/* Usage: the trend, where the credits went, and the filters for both. */}
          <section>
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {t("usage.title")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("usage.tzNote", { zone: t(timezoneLabelKey(sessionUser.timezone)) })}
            </p>

            <div className="mt-3 space-y-3 sm:space-y-4">
              <UsageWebSearchCard
                summary={report.webSearch.summary}
                totalCredits={report.summary.creditsUsed}
                labels={{
                  title: t("usage.webSearch.title"),
                  description: t("usage.webSearch.description"),
                  calls: t("usage.webSearch.calls"),
                  credits: t("usage.webSearch.credits"),
                  share: t("usage.webSearch.share"),
                  empty: t("usage.webSearch.empty"),
                  subsetHint: t("usage.webSearch.subsetHint"),
                }}
              />

              <Card padded={false} className="space-y-2.5 p-3 sm:p-4">
                <UsageScopePicker
                  basePath={BASE_PATH}
                  params={{ range: range.key, metric, group }}
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
                <div className="flex flex-col gap-2 border-t border-border pt-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5">
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
                    options={[
                      { value: "key", label: t("usage.breakdown.byKey") },
                      { value: "model", label: t("usage.breakdown.byModel") },
                    ]}
                  />
                  <Link
                    href={`${BASE_PATH}?reset=1`}
                    className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {t("usage.viewReset")}
                  </Link>
                </div>
              </Card>

              <Card padded={false} className="p-3 sm:p-4">
                <CardHeader title={t("usage.chart.title")} description={rangeLabel} />
                {/*
                    The cache hit rate, next to the trend it explains.

                    A trend of "input tokens" on its own says nothing about how
                    much of it was free: the same bar is 100% billed or 40%
                    billed depending on cache, and the reader has no way to tell
                    which they are looking at.

                    `cacheHitRate` returns null when nothing in the period
                    reported a cache, and null is shown as 「未上报」 rather than
                    as 0%. Those are different facts — "no prompt was ever
                    cached" is a claim about a vendor, and "this vendor does not
                    report a cache" is what an empty column has actually told us.
                */}
                {(() => {
                  const hit = cacheHitRate(report.summary);
                  return (
                    <div className="mb-3 flex items-start gap-2.5">
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                          hit === null
                            ? "bg-muted text-muted-foreground"
                            : hit.rate > 0
                              ? "bg-success/10 text-success"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        <Database className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs uppercase tracking-wider text-muted-foreground">
                          {t("usage.stat.cacheHit")}
                        </div>
                        <div className="mt-0.5 truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
                          {hit === null
                            ? t("usage.stat.cacheUnreported")
                            : `${(hit.rate * 100).toFixed(1)}%`}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {hit === null
                            ? t("usage.stat.cacheUnreportedHint")
                            : t("usage.stat.cacheHitHint", {
                                cached: formatNumber(hit.cachedTokens),
                                // The denominator the rate was computed from,
                                // taken from the same object. Printing the whole
                                // period's prompt tokens here put two different
                                // fractions on screen at once.
                                prompt: formatNumber(hit.reportedPromptTokens),
                                reported: formatNumber(hit.reportedRequests),
                              })}
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <UsageBarChart
                  points={report.series}
                  grain={range.grain}
                  metric={metric}
                  metricLabel={metricLabel}
                  summary={report.summary}
                  labels={labels}
                  paceLabel={t("usage.chart.average", {
                    unit: t(
                      range.grain === "hour"
                        ? "usage.chart.grainHour"
                        : "usage.chart.grainDay",
                    ),
                    value: formatUsageMetric(pace.average, metric),
                    peak: formatUsageMetric(pace.peak, metric),
                  })}
                  emptyLabel={t("usage.empty")}
                />
              </Card>

              {report.truncatedKeys > 0 && (
                <p className="text-xs text-warning">
                  {t("usage.truncated", { max: MAX_LOGS_PER_KEY })}
                </p>
              )}

              <Card padded={false} className="p-3 sm:p-4">
                <CardHeader title={t("usage.breakdown.title")} description={rangeLabel} />
                <UsageBreakdownTable
                  rows={rows}
                  headers={headers}
                  emphasis={metric}
                  emptyLabel={t("usage.empty")}
                />
              </Card>
            </div>
          </section>

          <p className="text-center text-xs text-muted-foreground">
            {t("dashboard.help.contactAdmin")}
          </p>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
