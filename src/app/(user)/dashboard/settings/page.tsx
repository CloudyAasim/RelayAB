import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, CardHeader } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { DisplayNameForm } from "./DisplayNameForm";
import { TimezoneForm } from "./TimezoneForm";
import { cachedGetUserById } from "@/lib/db/data-cache";
import { DEFAULT_TIMEZONE } from "@/lib/db/types";
import { AccountCredentialPanel } from "@/lib/assistant/CredentialPanel";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { t } = await getT();

  // Use cached function to avoid redundant Redis calls
  const fresh = await cachedGetUserById(user.id);
  const displayName = fresh?.displayName ?? user.displayName ?? user.username;

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("settings.title")}</SectionPageLayout.Title>
      {/* No description: the four cards below are the settings, and each one
          is titled. */}
      <SectionPageLayout.Content>
        <div className="space-y-6">
          <Card>
            {/* First, because it is the one that is easy to miss everywhere
                else: it decides whether the assistant can spend your quota at
                all, and the place you look for it is the assistant itself.

                No description: the switch below says what it does, in more
                detail than a line under the title could. */}
            <CardHeader title={t("settings.assistantCredential.title")} />
            <AccountCredentialPanel />
          </Card>
          <Card>
            <CardHeader
              title={t("settings.profile.title")}
              description={t("settings.profile.desc")}
            />
            <DisplayNameForm
              initialDisplayName={displayName}
              username={user.username}
            />
          </Card>
          <Card>
            <CardHeader
              title={t("settings.timezone.title")}
              description={t("settings.timezone.desc")}
            />
            <TimezoneForm initialTimezone={fresh?.timezone ?? DEFAULT_TIMEZONE} />
          </Card>
          <Card>
            {/* No description: the three fields below are labelled 当前密码、
                新密码、确认新密码, which is the whole sentence. */}
            <CardHeader title={t("settings.password.title")} />
            <ChangePasswordForm />
          </Card>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
