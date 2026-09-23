import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, CardHeader } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { DisplayNameForm } from "./DisplayNameForm";
import { cachedGetUserById } from "@/lib/db/data-cache";

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
      <SectionPageLayout.Content>
        <div className="space-y-6">
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
              title={t("settings.password.title")}
              description={t("settings.password.desc")}
            />
            <ChangePasswordForm />
          </Card>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
