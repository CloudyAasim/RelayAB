import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
import { getCurrentUser } from "@/lib/auth/session";
import { listUsers } from "@/lib/db/users";
import { listProviders } from "@/lib/db/providers";
import { Card, CardHeader } from "@/components/ui/Card";
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
import { formatDate } from "@/lib/utils";
import { getT } from "@/lib/i18n/server";
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";
import { CreateUserButton } from "./CreateUserButton";
import { UserActions } from "./UserActions";
import { AllocationEditor } from "./AllocationEditor";
import { Users as UsersIcon } from "lucide-react";

export default async function UsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const [{ users }, providers] = await Promise.all([
    listUsers({ limit: 200 }),
    listProviders({ enabledOnly: true }),
  ]);

  // Every client-visible model across enabled providers, so the allocation
  // editor can offer a real checklist instead of a free-text field.
  const availableModels = Array.from(
    new Set(providers.flatMap((p) => Object.keys(p.modelMapping))),
  ).sort();

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("admin.users.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("admin.users.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Actions>
          <CreateUserButton />
        </SectionPageLayout.Actions>
        <SectionPageLayout.Content>
          <Card>
            {users.length === 0 ? (
              <EmptyState
                icon={<UsersIcon className="h-5 w-5" />}
                title={t("admin.users.empty.title")}
                description={t("admin.users.empty.description")}
                action={<CreateUserButton />}
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>{t("admin.users.create.username")}</TH>
                    <TH>{t("admin.users.create.displayName")}</TH>
                    <TH>{t("admin.users.create.role")}</TH>
                    <TH>{t("dashboard.table.status")}</TH>
                    <TH>{t("dashboard.table.time")}</TH>
                    <TH className="w-32 text-right">{t("common.actions")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {users.map((u) => (
                    <TR key={u.id}>
                      <TD>
                        <div className="font-medium">{u.username}</div>
                        <div className="text-xs text-muted-foreground">{u.displayName}</div>
                      </TD>
                      <TD className="text-muted-foreground">{u.displayName}</TD>
                      <TD>
                        <Badge tone={u.role === "admin" ? "primary" : "neutral"}>
                          {u.role === "admin"
                            ? t("admin.users.role.admin")
                            : t("admin.users.role.user")}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge tone={u.disabled ? "neutral" : "success"}>
                          {u.disabled
                            ? t("dashboard.status.disabled")
                            : t("dashboard.status.enabled")}
                        </Badge>
                      </TD>
                      <TD className="text-muted-foreground">{formatDate(u.createdAt)}</TD>
                      <TD className="text-right">
                        <UserActions user={u} />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card className="mt-6">
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  <UsersIcon className="h-4 w-4 text-muted-foreground" />
                  {t("admin.users.allocation.title")}
                </span>
              }
              description={t("admin.users.allocation.desc")}
            />
            <AllocationEditor users={users} availableModels={availableModels} />
          </Card>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
