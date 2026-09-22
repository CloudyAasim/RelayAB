import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listUsers } from "@/lib/db/users";
import { listAllApiKeys } from "@/lib/db/keys";
import { listProviders } from "@/lib/db/providers";
import { aggregateByKey } from "@/lib/db/usage";
import { Card, CardHeader, StatCard } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from "@/components/ui/Table";
import { formatNumber, formatDate } from "@/lib/utils";
import { getT } from "@/lib/i18n/server";
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";
import {
  Users,
  KeyRound,
  Server,
  Activity,
  Coins,
  TrendingUp,
} from "lucide-react";

export default async function AdminOverviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const [{ t }, { users }, keys, providers] = await Promise.all([
    getT(),
    listUsers({ limit: 200 }),
    listAllApiKeys({}),
    listProviders(),
  ]);

  // Best-effort usage aggregate; the underlying fn is aggregateByKey which returns
  // per-key totals. We sum them.
  const aggTotals = (await Promise.all(keys.map((k) => aggregateByKey(k.id)))).reduce(
    (acc, x) => ({
      totalTokens: acc.totalTokens + x.totalTokens,
      creditsUsed: acc.creditsUsed + x.creditsUsed,
    }),
    { totalTokens: 0, creditsUsed: 0 },
  );

  const recentUsers = [...users]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("admin.overview.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("admin.overview.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          {/* Stat row */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t("admin.stat.users")}
              value={formatNumber(users.length)}
              icon={<Users className="h-4 w-4" />}
              tone="primary"
            />
            <StatCard
              label={t("admin.stat.apiKeys")}
              value={formatNumber(keys.length)}
              icon={<KeyRound className="h-4 w-4" />}
              tone="info"
              hint={`${keys.filter((k) => k.enabled).length} ${t("dashboard.stat.activeKeys").toLowerCase()}`}
            />
            <StatCard
              label={t("admin.stat.providers")}
              value={formatNumber(providers.length)}
              icon={<Server className="h-4 w-4" />}
              tone="success"
              hint={`${providers.filter((p) => p.enabled).length} ${t("dashboard.status.enabled")}`}
            />
            <StatCard
              label={t("admin.stat.tokens")}
              value={formatNumber(aggTotals.totalTokens)}
              icon={<Activity className="h-4 w-4" />}
              tone="warning"
              hint={t("admin.stat.tokensHint")}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    {t("admin.overview.recentUsers")}
                  </span>
                }
              />
              {recentUsers.length === 0 ? (
                <EmptyState title={t("admin.users.empty.title")} />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>{t("admin.users.create.username")}</TH>
                      <TH>{t("admin.users.create.role")}</TH>
                      <TH>{t("dashboard.table.time")}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {recentUsers.map((u) => (
                      <TR key={u.id}>
                        <TD>
                          <div className="font-medium">{u.username}</div>
                          <div className="text-xs text-muted-foreground">{u.displayName}</div>
                        </TD>
                        <TD>
                          <Badge tone={u.role === "admin" ? "primary" : "neutral"}>
                            {u.role === "admin"
                              ? t("admin.users.role.admin")
                              : t("admin.users.role.user")}
                          </Badge>
                        </TD>
                        <TD className="text-muted-foreground">{formatDate(u.createdAt)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Coins className="h-4 w-4 text-muted-foreground" />
                    {t("admin.overview.usage")}
                  </span>
                }
              />
              <div className="space-y-3">
                <UsageRow
                  label={t("admin.overview.usageTotalTokens")}
                  value={formatNumber(aggTotals.totalTokens)}
                />
                <UsageRow
                  label={t("admin.overview.usageTotalCredits")}
                  value={formatNumber(aggTotals.creditsUsed / 1000)}
                />
                <UsageRow
                  label={t("admin.overview.usageActiveKeys")}
                  value={`${keys.filter((k) => k.enabled).length} / ${keys.length}`}
                />
              </div>
            </Card>
          </div>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
