import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, StatCard, CardHeader } from "@/components/ui/Card";
import { Badge, StatusDot } from "@/components/ui/Badge";
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from "@/components/ui/Table";
import { formatCredits, formatNumber, formatDate } from "@/lib/utils";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import {
  CreateKeyButton,
  type UserAllocation,
} from "./CreateKeyButton";
import { UserKeyActions } from "./UserKeyActions";
import { AllocationSummary } from "./AllocationSummary";
import { KeyRound, Coins, Activity, Plus, Sparkles } from "lucide-react";
import {
  cachedGetUserById,
  cachedListApiKeysByUser,
  cachedAggregateByUser,
} from "@/lib/db/data-cache";

export default async function DashboardPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const [{ t }, fullUser, keyPage] = await Promise.all([
    getT(),
    cachedGetUserById(sessionUser.id),
    cachedListApiKeysByUser(sessionUser.id, 200),
  ]);
  const keys = keyPage.keys;
  const agg = await cachedAggregateByUser(keys.map((k) => k.id));

  const allocation: UserAllocation | null = fullUser
    ? {
        maxActiveKeys: fullUser.maxActiveKeys,
        activeKeyCount: keys.filter((k) => k.enabled).length,
        allowedModels: fullUser.allowedModels,
      }
    : null;

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>
        {t("dashboard.welcome", { name: fullUser?.displayName ?? sessionUser.username })}
      </SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CreateKeyButton allocation={allocation} />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {/* Stats row - responsive: 1 col → 2 cols → 3 cols */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          <StatCard
            label={t("dashboard.stat.activeKeys")}
            value={formatNumber(keys.filter((k) => k.enabled).length)}
            icon={<KeyRound className="h-4 w-4" />}
            tone="primary"
          />
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

        {/* Allocation banner */}
        {fullUser && (
          <div className="mt-4 sm:mt-6">
            <AllocationSummary
              quotaType={fullUser.quotaType}
              quotaLimit={fullUser.quotaLimit}
              quotaUsed={fullUser.quotaUsed}
              allowedModels={fullUser.allowedModels}
              maxActiveKeys={fullUser.maxActiveKeys}
              activeKeyCount={keys.filter((k) => k.enabled).length}
            />
          </div>
        )}

        {/* API Keys list */}
        <div className="mt-4 sm:mt-6">
          <Card>
            <CardHeader
              title={t("dashboard.apiKeys.title")}
              description={t("dashboard.apiKeys.description")}
            />
            {keys.length === 0 ? (
              <EmptyState
                icon={<Sparkles className="h-5 w-5" />}
                title={t("dashboard.apiKeys.empty.title")}
                description={t("dashboard.apiKeys.empty.description")}
                action={
                  <CreateKeyButton
                    allocation={allocation}
                    label={
                      <>
                        <Plus className="mr-1.5 h-4 w-4" />
                        {t("dashboard.createKey.button")}
                      </>
                    }
                  />
                }
              />
            ) : (
              <div className="overflow-x-auto -mx-3 sm:mx-0">
                <Table>
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
                          {formatDate(k.lastUsedAt)}
                        </TD>
                        <TD className="hidden xl:table-cell text-muted-foreground">
                          {formatDate(k.expiresAt)}
                        </TD>
                        <TD className="text-center">
                          <StatusDot tone={k.enabled ? "success" : "danger"} />
                        </TD>
                        <TD className="text-right">
                          <UserKeyActions apiKey={k} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Card>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground sm:mt-8">
          {t("dashboard.help.contactAdmin")}
        </p>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
