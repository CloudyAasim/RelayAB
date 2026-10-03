import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { cachedGetSettings } from "@/lib/db/data-cache";
import { loadConfig } from "@/lib/config";
import { Card } from "@/components/ui/Card";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { SettingsForm } from "./SettingsForm";
import { DocsPagesForm, type DocsPageValues } from "./DocsPagesForm";
import { DocsSiteForm, type SiteDocsValues } from "./DocsSiteForm";

export const dynamic = "force-dynamic";

/**
 * System settings.
 *
 * Each card is a form with its own button and sends only its own fields. They
 * used to be one component and one button, which meant saving the support
 * contact also rewrote the custom pages and the per-model notes from whatever
 * the form happened to be holding.
 *
 * The per-model notes are not here at all any more — they are a list over every
 * model the deployment serves, and they have their own page.
 */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();

  let dbPublicUrl: string | undefined;
  let envPublicUrl: string | null = null;
  let docsPages: DocsPageValues["docPages"] = [];
  // Optional, not required-and-undefined: the form treats an absent field as an
  // empty one, and a required key that is always undefined is a different type
  // than the one the form takes.
  let site: SiteDocsValues = {};

  try {
    const settings = await cachedGetSettings();
    dbPublicUrl = settings.publicUrl;
    docsPages = settings.docPages ?? [];
    site = {
      ...(settings.siteName !== undefined && { siteName: settings.siteName }),
      ...(settings.siteDescription !== undefined && { siteDescription: settings.siteDescription }),
      ...(settings.announcement !== undefined && { announcement: settings.announcement }),
      ...(settings.supportContact !== undefined && { supportContact: settings.supportContact }),
      ...(settings.publicCatalog !== undefined && { publicCatalog: settings.publicCatalog }),
    };
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
                <SettingsForm currentUrl={currentUrl} envConfigured={!!envPublicUrl} />
              </div>
            </div>
          </Card>

          <DocsSiteForm initial={site} />
          <DocsPagesForm initial={docsPages} />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
