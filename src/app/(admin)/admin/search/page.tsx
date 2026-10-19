import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { getSettings } from "@/lib/db/settings";
import { listRecentSearchUsage, searchUsageTotals } from "@/lib/db/usage";
import { loadSearchConfig } from "@/lib/search/config";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { SearchPanel } from "./SearchPanel";

export const dynamic = "force-dynamic";

/**
 * Web search, as an operator sees it.
 *
 * The panel is deliberately one screen: the switch, the price, whether the
 * backend answers, what it has cost, and a box that runs a query. Those are
 * the five questions the feature actually raises, and splitting them across
 * cards that each save separately is how the settings page used to rewrite
 * three unrelated forms with one button.
 */
export default async function SearchAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const settings = await getSettings();
  const config = await loadSearchConfig(settings);

  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [last24h, last7d, total, recent] = await Promise.all([
    searchUsageTotals(since24h),
    searchUsageTotals(since7d),
    searchUsageTotals(),
    listRecentSearchUsage(20),
  ]);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.search.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <SearchPanel
          enabled={config.enabled}
          storedEnabled={settings.searchEnabled ?? null}
          creditsPerCall={config.creditsPerCall}
          storedCredits={settings.searchCreditsPerCall ?? null}
          backendConfigured={config.backendConfigured}
          backendName={config.backendName}
          backendUrl={config.backendUrl}
          maxResults={MAX_SEARCH_RESULTS}
          stats={{ last24h, last7d, total }}
          recent={recent}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
