/**
 * app/(admin)/admin/search/page.tsx
 *
 * The search backends, one row each.
 *
 * ## The list is the whole page
 *
 * There used to be a "运行状态" card below it: whether search was on, which
 * backend served it, what it cost, and a feature-wide switch. Every one of
 * those facts is already in the list — the row that is serving says so, the
 * row says what it costs, and a row that is switched off is not serving — and
 * the switch beside the list was a second source of truth for the same fact.
 * Two sources of truth for one state is how a panel comes to say "on" while
 * the endpoint refuses.
 *
 * So: **the rows are the switch.** Search is on when at least one enabled row
 * can answer, and off when they are all disabled. The only thing that is not
 * a row is the environment fallback — the `SEARXNG_URL` / `TAVILY_API_KEY` /
 * `BRAVE_SEARCH_API_KEY` path a deployment uses before it has any row — and
 * its price is editable in the empty state, because that is the only moment
 * the fallback is the thing being used.
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
import { activeSearchBackendInfo } from "@/lib/search/resolve";
import { SEARCH_TEMPLATES } from "@/lib/search/templates";
import { specDrift, type SpecDrift } from "@/lib/search/drift";
import { Card } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD, EmptyState } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { CreateSearchProviderButton } from "./CreateSearchProviderButton";
import { SearchProviderActions } from "./SearchProviderActions";
import { EnvFallbackPrice } from "./EnvFallbackPrice";

export const dynamic = "force-dynamic";

/**
 * The built-in templates, as the form needs them.
 *
 * Plain documents, not code: the form can import one, edit it and save it
 * back, and a deployment can then carry a vendor this build has never heard of.
 */
const TEMPLATE_OPTIONS = SEARCH_TEMPLATES.map((template) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  spec: template.spec,
}));

function kindLabel(t: (key: string) => string, kind: PublicSearchProvider["kind"]): string {
  return t(`admin.searchProviders.kinds.${kind}`);
}

/**
 * How a stored spec compares to the template it came from.
 *
 * The interesting case is "differs": the template moved and the stored copy did
 * not. The paths are in the tooltip, because a badge that says "3 differences"
 * without saying where is a badge nobody acts on.
 */
function SpecBadge({
  drift,
  t,
}: {
  drift: SpecDrift;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (drift.kind === "in-sync") {
    return <Badge tone="success">{t("admin.searchProviders.drift.inSync")}</Badge>;
  }
  if (drift.kind === "differs") {
    return (
      <span title={drift.paths.join("\n")}>
        <Badge tone="warning">
          {t("admin.searchProviders.drift.differs", { count: drift.paths.length })}
        </Badge>
      </span>
    );
  }
  return <Badge tone="info">{t("admin.searchProviders.drift.noTemplate")}</Badge>;
}

export default async function SearchAdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const [settings, records, backend] = await Promise.all([
    getSettings(),
    listSearchProviders(),
    activeSearchBackendInfo(),
  ]);
  const providers = records.map(toPublicSearchProvider);
  // The row that will actually serve the next search: the resolver's own
  // answer, not "the first one in the list" — a row can be enabled and still
  // be unable to answer (no key, an unreadable spec).
  const activeId = backend.source === "db" ? backend.usageProviderId : null;

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.searchProviders.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <CreateSearchProviderButton templates={TEMPLATE_OPTIONS} />
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
              action={<CreateSearchProviderButton templates={TEMPLATE_OPTIONS} />}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>{t("admin.searchProviders.name")}</TH>
                  <TH>{t("admin.searchProviders.kind")}</TH>
                  <TH>{t("admin.searchProviders.baseUrl")}</TH>
                  <TH>{t("admin.searchProviders.priority")}</TH>
                  <TH>{t("admin.searchProviders.creditsPerCall")}</TH>
                  <TH>{t("admin.searchProviders.spec")}</TH>
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
                    <TD className="text-muted-foreground">
                      {p.creditsPerCall}
                    </TD>
                    <TD>
                      {p.spec ? (
                        <SpecBadge drift={specDrift(p.spec)} t={t} />
                      ) : (
                        <span title={t("admin.searchProviders.legacyHint")}>
                          <Badge tone="neutral">{t("admin.searchProviders.legacy")}</Badge>
                        </span>
                      )}
                    </TD>
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
                      <SearchProviderActions provider={p} templates={TEMPLATE_OPTIONS} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>

        {providers.length === 0 && (
          <EnvFallbackPrice
            creditsPerCall={settings.searchCreditsPerCall ?? null}
            envConfigured={Boolean(process.env.SEARXNG_URL || process.env.TAVILY_API_KEY || process.env.BRAVE_SEARCH_API_KEY)}
          />
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
