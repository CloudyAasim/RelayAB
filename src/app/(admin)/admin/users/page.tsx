import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
import { getCurrentUser } from "@/lib/auth/session";
import { listUsers } from "@/lib/db/users";
import { listProviders } from "@/lib/db/providers";
import { toPublicUser } from "@/lib/db/types";
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
import { Button } from "@/components/ui/Button";
import { readFlash } from "@/lib/http/flash";
import { CreateUserButton } from "./CreateUserButton";
import { UserActions } from "./UserActions";
import { AllocationEditor } from "./AllocationEditor";
import { DeployProbe } from "./DeployProbe";
import { Users as UsersIcon } from "lucide-react";

// VERSION STAMP — bump on every meaningful change to this page.
// Visible in the rendered HTML (data attribute + footer line) so we can
// verify which code is actually deployed without ambiguity.
const PAGE_VERSION = "v9-nojs-toggle-flash-2025-09-22";

export default async function UsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const flash = await readFlash();
  const [{ users }, providers] = await Promise.all([
    listUsers({ limit: 200 }),
    listProviders({ enabledOnly: true }),
  ]);

  const availableModels = Array.from(
    new Set(providers.flatMap((p) => Object.keys(p.modelMapping))),
  ).sort();

  // The table's client components receive their props across the
  // server→client boundary, which means anything handed to them is
  // serialized into the HTML/RSC payload the browser downloads. Hand over the
  // password-hash-free projection (same helper the JSON APIs use) so bcrypt
  // hashes never leave the server.
  const publicUsers = users.map(toPublicUser);

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
          {/* VERSION STAMP: do not remove. Helps verify deployment. */}
          <div
            data-page-version={PAGE_VERSION}
            className="mb-4 rounded-md border border-dashed border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
          >
            <strong>部署版本：</strong> <code className="font-mono">{PAGE_VERSION}</code>
            {" · 共 "}
            <span data-user-count={publicUsers.length}>{publicUsers.length}</span>
            {" 个用户 · "}
            <span data-disabled-count={publicUsers.filter((u) => u.disabled).length}>
              {publicUsers.filter((u) => u.disabled).length}
            </span>
            {" 个已停用 · "}
            <DeployProbe />
          </div>

          {/*
            Result of the last form-POST (toggle / delete). Without this the
            page is silent about failures and "nothing happened" is
            indistinguishable from "the request was never sent".
          */}
          {flash && (
            <div
              data-flash={flash.kind}
              className={
                "mb-4 rounded-md border px-3 py-2 text-sm " +
                (flash.kind === "ok"
                  ? "border-success/40 bg-success/10 text-success-foreground"
                  : "border-destructive/40 bg-destructive/10 text-destructive")
              }
            >
              {flash.message}
            </div>
          )}

          <Card data-users-table>
            {publicUsers.length === 0 ? (
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
                    <TH className="w-48 text-right">{t("common.actions")}</TH>
                  </TR>
                </THead>
                <TBody>
                  {publicUsers.map((u) => (
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
                      <TD data-user-id={u.id} data-disabled={String(u.disabled)}>
                        <Badge tone={u.disabled ? "neutral" : "success"}>
                          {u.disabled
                            ? t("dashboard.status.disabled")
                            : t("dashboard.status.enabled")}
                        </Badge>
                      </TD>
                      <TD className="text-muted-foreground">{formatDate(u.createdAt)}</TD>
                      <TD className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {/*
                            Plain server-rendered form: the enable/disable
                            action must survive a build whose client JS never
                            boots, so it does NOT live inside the (client-only)
                            ⋮ modal.
                          */}
                          <form
                            method="POST"
                            action={`/api/admin/users/${u.id}/toggle`}
                            data-inline-toggle
                          >
                            <input type="hidden" name="userId" value={u.id} />
                            <input
                              type="hidden"
                              name="disabled"
                              value={u.disabled ? "false" : "true"}
                            />
                            <Button type="submit" size="sm" variant="outline">
                              {u.disabled
                                ? t("admin.users.action.enable")
                                : t("admin.users.action.disable")}
                            </Button>
                          </form>
                          <UserActions user={u} />
                        </div>
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
            <AllocationEditor users={publicUsers} availableModels={availableModels} />
          </Card>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
