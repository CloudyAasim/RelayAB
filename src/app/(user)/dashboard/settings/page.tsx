import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Card, CardHeader } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import {
  AuthenticatedLayout,
  SectionPageLayout,
} from "@/components/layouts";
import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { t } = await getT();

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      pageTitle={t("settings.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("settings.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <Card>
            <CardHeader
              title={t("settings.password.title")}
              description={t("settings.password.desc")}
            />
            <ChangePasswordForm />
          </Card>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
