import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { cachedGetSettings, cachedBuildModelCatalog } from "@/lib/db/data-cache";

import { loadConfig } from "@/lib/config";
import { Card } from "@/components/ui/Card";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { SettingsForm } from "./SettingsForm";
import { DocsSettingsForm } from "./DocsSettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();

  let dbPublicUrl: string | undefined;
  let envPublicUrl: string | null = null;
  let docsSettings: {
    siteName?: string;
    siteDescription?: string;
    announcement?: string;
    supportContact?: string;
    modelNotes?: Record<string, never>;
  } = {};
  let catalogModels: Array<{ id: string; kind: "chat" | "media"; displayName: string }> = [];

  try {
    const settings = await cachedGetSettings();
    dbPublicUrl = settings.publicUrl;
    docsSettings = {
      ...(settings.siteName !== undefined && { siteName: settings.siteName }),
      ...(settings.siteDescription !== undefined && { siteDescription: settings.siteDescription }),
      ...(settings.announcement !== undefined && { announcement: settings.announcement }),
      ...(settings.supportContact !== undefined && { supportContact: settings.supportContact }),
      ...(settings.modelNotes !== undefined && { modelNotes: settings.modelNotes }),
    } as typeof docsSettings;
  } catch (e) {
    console.error("Failed to load settings:", e);
  }

  try {
    // The notes editor offers the ids that actually exist, so an operator
    // never has to type a model name from memory and get it silently wrong.
    const catalog = await cachedBuildModelCatalog();
    catalogModels = catalog.models.map((m) => ({
      id: m.id,
      kind: m.kind,
      displayName: m.displayName,
    }));
  } catch (e) {
    console.error("Failed to load catalog:", e);
  }

  try {
    const cfg = loadConfig();
    envPublicUrl = cfg.RELAY_PUBLIC_URL ?? null;
  } catch {
    // Config not available
  }

  const currentUrl = dbPublicUrl ?? envPublicUrl ?? "";

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.settings.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className="space-y-6">
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

          {/* Site copy and per-model notes. The model list itself is read live
              from the providers, so this panel can only add prose to it. */}
          <DocsSettingsForm initial={docsSettings} models={catalogModels} />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
