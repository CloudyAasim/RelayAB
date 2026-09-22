import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
import { getCurrentUser } from "@/lib/auth/session";
import { listAllApiKeys } from "@/lib/db/keys";
import { listUsers } from "@/lib/db/users";
import { Card } from "@/components/ui/Card";
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
import { formatNumber, formatDate, formatCredits } from "@/lib/utils";
import { getT } from "@/lib/i18n/server";
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";
import { CreateKeyButton } from "./CreateKeyButton";
import { KeyActions } from "./KeyActions";
import { KeyRound } from "lucide-react";

export default async function KeysPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const [{ users }, keys] = await Promise.all([
    listUsers({ limit: 200 }),
    listAllApiKeys({}),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.username]));
  const userById = new Map(users.map((u) => [u.id, u]));

  /**
   * Render the owning account's remaining pool for a key row. Quota is not a
   * property of the key, so showing a per-key number here would be a lie.
   */
  const ownerPoolLabel = (owner: (typeof users)[number] | undefined): string => {
    if (!owner) return "—";
    if (owner.quotaLimit === 0) return t("admin.keys.table.noCredits");
    const remaining = Math.max(0, owner.quotaLimit - owner.quotaUsed);
    return owner.quotaType === "tokens"
      ? `${formatNumber(remaining)} / ${formatNumber(owner.quotaLimit)} tokens`
      : `${formatCredits(remaining)} / ${formatCredits(owner.quotaLimit)}`;
  };

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      pageTitle={t("admin.keys.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("admin.keys.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <CreateKeyButton users={users.map((u) => ({ id: u.id, username: u.username }))} />
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <Card>
            {keys.length === 0 ? (
              <EmptyState
                icon={<KeyRound className="h-5 w-5" />}
                title={t("admin.keys.empty.title")}
                description={t("admin.keys.empty.description")}
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>{t("admin.keys.create.label")}</TH>
                    <TH>{t("admin.keys.create.user")}</TH>
                    <TH>{t("admin.keys.table.ownerPool")}</TH>
                    <TH>{t("admin.keys.table.modelScope")}</TH>
                    <TH>{t("admin.keys.create.expiresAt")}</TH>
                    <TH>{t("dashboard.table.status")}</TH>
                    <TH className="w-20 text-right">{t("common.actions")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {keys.map((k) => (
                    <TR key={k.id}>
                      <TD className="font-medium">{k.label}</TD>
                      <TD>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {userMap.get(k.userId) ?? "—"}
                        </code>
                      </TD>
                      {/* Quota belongs to the owner, so the useful number here
                          is what that account has left — not a per-key figure. */}
                      <TD className="text-muted-foreground">
                        {ownerPoolLabel(userById.get(k.userId))}
                      </TD>
                      <TD className="text-muted-foreground">
                        {k.allowedModels.length > 0
                          ? k.allowedModels.join(", ")
                          : t("dashboard.table.inheritsAccount")}
                      </TD>
                      <TD className="text-muted-foreground">{formatDate(k.expiresAt)}</TD>
                      <TD>
                        <Badge tone={k.enabled ? "success" : "neutral"}>
                          {k.enabled ? t("dashboard.status.enabled") : t("dashboard.status.disabled")}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <KeyActions apiKey={k} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
