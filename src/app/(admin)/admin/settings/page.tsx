import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/db/settings";
import { loadConfig } from "@/lib/config";
import { Card } from "@/components/ui/Card";
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  
  let dbPublicUrl: string | undefined;
  let envPublicUrl: string | null = null;
  
  try {
    const settings = await getSettings();
    dbPublicUrl = settings.publicUrl;
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  
  try {
    const cfg = loadConfig();
    envPublicUrl = cfg.RELAY_PUBLIC_URL ?? null;
  } catch {
    // Config not available
  }

  const currentUrl = dbPublicUrl ?? envPublicUrl ?? "";

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      pageTitle={t("admin.settings.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("admin.settings.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <Card className="max-w-2xl">
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-medium mb-2">{t("admin.settings.publicUrl")}</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {t("admin.settings.publicUrlDescription")}
                </p>
                <SettingsForm 
                  currentUrl={currentUrl}
                  envConfigured={!!envPublicUrl}
                />
              </div>
            </div>
          </Card>
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
