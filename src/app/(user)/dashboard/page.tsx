import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listApiKeysByUser } from "@/lib/db/keys";
import { aggregateByUser } from "@/lib/db/usage";
import { getUserById } from "@/lib/db/users";
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
import {
  AuthenticatedLayout,
  SectionPageLayout,
} from "@/components/layouts";
import {
  CreateKeyButton,
  type UserAllocation,
} from "./CreateKeyButton";
import { UserKeyActions } from "./UserKeyActions";
import { AllocationSummary } from "./AllocationSummary";
import { KeyRound, Coins, Activity, Plus, Sparkles } from "lucide-react";

export default async function DashboardPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const { t } = await getT();
  const fullUser = await getUserById(sessionUser.id);
  const { keys } = await listApiKeysByUser(sessionUser.id, { limit: 200 });
  const agg = await aggregateByUser(keys.map((k) => k.id));

  const allocation: UserAllocation | null = fullUser
    ? {
        maxActiveKeys: fullUser.maxActiveKeys,
        activeKeyCount: keys.filter((k) => k.enabled).length,
        allowedModels: fullUser.allowedModels,
      }
    : null;

  return (
    <AuthenticatedLayout
      role={sessionUser.role}
      username={sessionUser.username}
      pageTitle={t("dashboard.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>
          {t("dashboard.welcome", { username: sessionUser.username })}
        </SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <CreateKeyButton allocation={allocation} />
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          {/* Stats row */}
          <div className="grid gap-4 sm:grid-cols-3">
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
              tone="success"
            />
          </div>

          {/* Allocation banner */}
          {fullUser && (
            <div className="mt-6">
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
          <div className="mt-6">
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
                <Table>
                  <THead>
                    <TR>
                      <TH>{t("admin.keys.create.label")}</TH>
                      <TH>{t("dashboard.table.key")}</TH>
                      <TH>{t("dashboard.table.modelScope")}</TH>
                      <TH>{t("dashboard.table.lastUsed")}</TH>
                      <TH>{t("admin.keys.create.expiresAt")}</TH>
                      <TH>{t("dashboard.table.status")}</TH>
                      <TH className="w-32 text-right">
                        {t("common.actions")}
                      </TH>
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
                        {/* Quota is shared, so this column shows the key's own
                            model scope instead of a per-key balance. */}
                        <TD className="text-muted-foreground">
                          {k.allowedModels.length > 0
                            ? k.allowedModels.join(", ")
                            : t("dashboard.table.inheritsAccount")}
                        </TD>
                        <TD className="text-muted-foreground">
                          {formatDate(k.lastUsedAt)}
                        </TD>
                        <TD className="text-muted-foreground">
                          {formatDate(k.expiresAt)}
                        </TD>
                        <TD>
                          {k.enabled ? (
                            <Badge tone="success">
                              <StatusDot tone="success" pulse={false} className="mr-1" />
                              {t("dashboard.status.enabled")}
                            </Badge>
                          ) : (
                            <Badge tone="neutral">
                              <StatusDot tone="neutral" pulse={false} className="mr-1" />
                              {t("dashboard.status.disabled")}
                            </Badge>
                          )}
                          {k.expiresAt && new Date(k.expiresAt) < new Date() && (
                            <Badge tone="warning" className="ml-1">
                              {t("dashboard.status.expired")}
                            </Badge>
                          )}
                        </TD>
                        <TD className="text-right">
                          <UserKeyActions apiKey={k} />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          </div>

          <p className="mt-8 text-center text-xs text-muted-foreground">
            {t("dashboard.help.contactAdmin")}
          </p>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
