/**
 * app/(admin)/admin/search/page.tsx
 *
 * Search providers, listed the same way as chat and media providers: one row
 * each, with edit/disable/delete/test behind the row actions. The feature-wide
 * switch and price sit below the list, because they are one setting rather
 * than one per row.
 *
 * Usage statistics are not here any more. They live on `/admin/usage`, where
 * every other kind of spend is reported, so the two cannot disagree.
 */
import { redirect } from "next/navigation";
import { Search } from "lucide-react";

import { getCurrentUser } from "@/lib/auth/session";
import {
  listSearchProviders,
  toPublicSearchProvider,
  type PublicSearchProvider,
} from "@/lib/db/search-providers";
import { getSettings } from "@/lib/db/settings";
import { loadSearchConfig } from "@/lib/search/config";
import { Card } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD, EmptyState } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { CreateSearchProviderButton } from "./CreateSearchProviderButton";
import { SearchProviderActions } from "./SearchProviderActions";
import { SearchPanel } from "./SearchPanel";

export const dynamic = "force-dynamic";

function kindLabel(t: (key: string) => string, kind: PublicSearchProvider["kind"]): string {
  return t(`admin.searchProviders.kinds.${kind}`);
}

export default async function SearchAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const [settings, config, records] = await Promise.all([
    getSettings(),
    loadSearchConfig(),
    listSearchProviders(),
  ]);
  const providers = records.map(toPublicSearchProvider);
  const activeId = config.backendSource === "db" ? config.backendProviderId : null;

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.searchProviders.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CreateSearchProviderButton />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("admin.searchProviders.description")}
        </p>

        <Card className="mb-6">
          {providers.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title={t("admin.searchProviders.empty")}
              description={t("admin.searchProviders.emptyHint")}
              action={<CreateSearchProviderButton />}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("admin.searchProviders.name")}</TH>
                  <TH>{t("admin.searchProviders.kind")}</TH>
                  <TH>{t("admin.searchProviders.baseUrl")}</TH>
                  <TH>{t("admin.searchProviders.priority")}</TH>
                  <TH>{t("dashboard.table.status")}</TH>
                  <TH className="w-40 text-right">{t("common.actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {providers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <div className="font-medium text-foreground">{p.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                    </TD>
                    <TD>
                      <Badge tone="primary">{kindLabel(t, p.kind)}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      <code className="text-xs">
                        {p.baseUrl || t("admin.searchProviders.defaultEndpoint")}
                      </code>
                      {p.hasApiKey && (
                        <div className="mt-1 text-xs">{t("admin.searchProviders.keySet")}</div>
                      )}
                    </TD>
                    <TD className="text-muted-foreground">{p.priority}</TD>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={p.enabled ? "success" : "neutral"}>
                          {p.enabled
                            ? t("dashboard.status.enabled")
                            : t("dashboard.status.disabled")}
                        </Badge>
                        {p.id === activeId && (
                          <Badge tone="info">{t("admin.searchProviders.active")}</Badge>
                        )}
                      </div>
                    </TD>
                    <TD className="text-right">
                      <SearchProviderActions provider={p} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        <SearchPanel
          enabled={config.enabled}
          storedEnabled={settings.searchEnabled ?? null}
          creditsPerCall={config.creditsPerCall}
          storedCredits={settings.searchCreditsPerCall ?? null}
          backendConfigured={config.backendConfigured}
          backendName={config.backendName}
          backendUrl={config.backendUrl}
          backendSource={config.backendSource}
          providerCount={providers.length}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
