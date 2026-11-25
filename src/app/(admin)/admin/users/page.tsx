import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
import { getCurrentUser } from "@/lib/auth/session";
import { listUsers } from "@/lib/db/users";
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { toPublicUser } from "@/lib/db/types";
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
import { formatDate } from "@/lib/utils";
import { timezoneToIana } from "@/lib/timezone";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { CreateUserButton } from "./CreateUserButton";
import { UserActions } from "./UserActions";
import { UserConfigButton, UserPoolSummary } from "./UserConfig";
import { groupModelsByKind } from "@/lib/admin/model-groups";
import { AllowedModelsSummary } from "@/components/models/AllowedModelsSummary";
import { Users as UsersIcon } from "lucide-react";

export default async function UsersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const timeZone = timezoneToIana(user.timezone);

  const { t } = await getT();
  const [{ users }, providers, mediaProviders] = await Promise.all([
    listUsers({ limit: 200 }),
    listProviders({ enabledOnly: true }),
    listMediaProviders({ enabledOnly: true }),
  ]);

  // Media models are authorized through the same per-account whitelist, so
  // they have to appear in the picker — otherwise an image model could never
  // be granted to a user.
  //
  // The picker groups them by kind (text, image, video, speech, music), so the
  // page hands it groups rather than one flat alphabet.
  const modelGroups = groupModelsByKind(providers, mediaProviders);

  const publicUsers = users.map(toPublicUser);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.users.title")}</SectionPageLayout.Title>
      {/* No description: the table's own column headers and the row actions
          say what this page is for. */}
      <SectionPageLayout.Actions>
        <CreateUserButton />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {/*
          One table, not a table plus a card grid.

          The page used to list every account twice — identity in the table,
          quota allocation in cards below it — so "change this person's pool
          and their display name" was two modals on two halves of one page. The
          allocation is now columns of the same row, and one modal holds every
          per-account setting.
        */}
        <Card data-users-table>
          {publicUsers.length === 0 ? (
            <EmptyState
              icon={<UsersIcon className="h-5 w-5" />}
              title={t("admin.users.empty.title")}
            />
          ) : (
            <Table bare>
              <THead>
                <TR>
                  <TH>{t("admin.users.create.username")}</TH>
                  <TH>{t("admin.users.create.role")}</TH>
                  <TH>{t("admin.users.allocation.quota")}</TH>
                  <TH>{t("admin.users.allocation.models")}</TH>
                  <TH className="hidden xl:table-cell">
                    {t("admin.users.allocation.maxActiveKeys")}
                  </TH>
                  <TH className="hidden lg:table-cell">{t("dashboard.table.time")}</TH>
                  <TH className="w-44 text-right">{t("common.actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {publicUsers.map((u) => (
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
                    <TD>
                      <UserPoolSummary user={u} />
                    </TD>
                    <TD>
                      <AllowedModelsSummary allowedModels={u.allowedModels} groups={modelGroups} />
                    </TD>
                    <TD className="hidden whitespace-nowrap text-muted-foreground xl:table-cell">
                      {u.maxActiveKeys > 0
                        ? u.maxActiveKeys
                        : t("admin.users.allocation.uncapped")}
                    </TD>
                    <TD className="hidden text-muted-foreground lg:table-cell">
                      {formatDate(u.createdAt, timeZone)}
                    </TD>
                    <TD className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <UserConfigButton user={u} modelGroups={modelGroups} />
                        <UserActions user={u} />
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}