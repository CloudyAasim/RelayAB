import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getUserById } from "@/lib/db/users";
import { Card, CardHeader } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import {
  AuthenticatedLayout,
  SectionPageLayout,
} from "@/components/layouts";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { DisplayNameForm } from "./DisplayNameForm";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { t } = await getT();

  // The session caches the display name so the shell can render it without a
  // Redis read on every page. This page is the editing surface, so it reads the
  // authoritative value — otherwise a change made in another browser would show
  // a stale seed here and saving would look like a no-op.
  const fresh = await getUserById(user.id);
  const displayName = fresh?.displayName ?? user.displayName ?? user.username;

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("settings.title")}
    >
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
    </AuthenticatedLayout>
  );
}
