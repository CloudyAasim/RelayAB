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
import { activeSearchBackendInfo, searchServiceUsability, searchServices } from "@/lib/search/resolve";
import { SEARCH_TEMPLATES } from "@/lib/search/templates";
import { specDrift, type SpecDrift } from "@/lib/search/drift";
import { Card } from "@/components/ui/Card";
import { Table, THead, TBody, TR, TH, TD, EmptyState } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { SectionPageLayout } from "@/components/layouts";
import { getT } from "@/lib/i18n/server";
import { MarkdownText } from "@/components/i18n/MarkdownText";
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
  const [settings, records] = await Promise.all([getSettings(), listSearchProviders()]);
  // The resolver's own answer, computed from the rows this page already read:
  // two reads of the same table can disagree, and a badge that points at a
  // different row than the one in the list is worse than no badge.
  const backend = await activeSearchBackendInfo(process.env, records);
  const providers = records.map(toPublicSearchProvider);

  /**
   * Why each row cannot answer, when it cannot.
   *
   * The panel used to show every enabled row in green, including the ones
   * that could never answer — a row with no key, or one whose key no longer
   * decrypts. They were skipped in silence, so the row the operator was
   * looking at was not the row that served, and nothing on the page said so.
   */
  const usability = new Map(providers.map((p) => [p.id, searchServiceUsability(records.find((r) => r.id === p.id)!)]));
  const unusable = new Map(
    providers
      .map((p) => [p.id, usability.get(p.id)?.reason ?? null] as const)
      .filter(([, reason]) => Boolean(reason)),
  );
  /** The services that can answer, which is what a client can ask for. */
  const services = searchServices(records);
  /**
   * The service the operator marked as the default.
   *
   * Read from the settings rather than from the resolver, because the settings
   * are what the mark *is* — the resolver only answers with it.
   */
  const defaultServiceId = settings.searchDefaultServiceId ?? null;

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.searchProviders.title")}</SectionPageLayout.Title>
      {/* No description: the table below is titled, and the rule that matters
          is said in the box above it. */}
      <SectionPageLayout.Actions>
        <CreateSearchProviderButton templates={TEMPLATE_OPTIONS} />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("admin.searchProviders.description")}
        </p>

        {/*
          The rule, said where the operator reads it.

          There is no default service — that is the point. A deployment may
          offer several, and the one that answers is the one somebody chose:
          the client by name, the person in their own settings. So the panel
          does not mark one as "the one that serves"; it says who chooses.

          The sentence carries `**…**` around the part that matters, and it
          used to reach the reader as literal asterisks — this was a `<p>` and
          the dictionary is plain text. The markdown renderer the docs panel
          already uses is what turns it into emphasis, and it escapes its
          input before it emits any markup.
        */}
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <MarkdownText text={t("admin.searchProviders.noDefault")} />
        </div>

        {/*
          The one thing the table cannot say on its own.

          A deployment whose service cannot answer looks, in the list, like a
          deployment with several healthy services — every row green, one of
          them marked as the one that answers. And the requests are failing.
          So the failure is said out loud, here, above the list.
        */}
        {backend.unusableReason && services.length === 0 && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {t("admin.searchProviders.notWorking", { reason: backend.unusableReason })}
          </div>
        )}

        <Card className="mb-6">
          {providers.length === 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title={t("admin.searchProviders.empty")}
              description={t("admin.searchProviders.emptyHint")}
              action={<CreateSearchProviderButton templates={TEMPLATE_OPTIONS} />}
            />
          ) : (
            <Table bare>
              <THead>
                <TR>
                  <TH>{t("admin.searchProviders.name")}</TH>
                  <TH>{t("admin.searchProviders.serviceId")}</TH>
                  <TH>{t("admin.searchProviders.kind")}</TH>
                  {/* Nine columns is the widest table in the app, and at 1280px
                      they did not fit: the browser squeezed the headers until
                      「优先级」 was three characters stacked vertically and
                      「每次调用积分」 was five — a header row 120 pixels tall
                      with vertical words in it.

                      So the endpoint (a long URL, and the edit form has it)
                      and the priority (a tie-breaker number) wait for a
                      genuinely wide window. The rest fits in 800 pixels, which
                      is what a 1280px screen has left after the rail. */}
                  <TH className="hidden 2xl:table-cell">{t("admin.searchProviders.baseUrl")}</TH>
                  <TH className="hidden 2xl:table-cell">{t("admin.searchProviders.priority")}</TH>
                  <TH>{t("admin.searchProviders.creditsPerCall")}</TH>
                  <TH className="hidden lg:table-cell">{t("admin.searchProviders.spec")}</TH>
                  <TH>{t("dashboard.table.status")}</TH>
                  <TH className="w-40 text-right">{t("common.actions")}</TH>
                </TR>
              </THead>
              <TBody>
                {providers.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{p.name}</span>
                        {/*
                          The one that answers when a caller names none.
                          Marked on the row rather than left to be inferred
                          from the order of the list — a default you have to
                          guess at is not a default.
                        */}
                        {defaultServiceId === p.serviceId && (
                          <Badge tone="primary">{t("admin.searchProviders.defaultBadge")}</Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{p.id}</div>
                    </TD>
                    <TD>
                      {/* The name a client asks for. The one that answers is
                          marked below, so the two can be told apart. */}
                      <code className="text-xs">{p.serviceId || "—"}</code>
                    </TD>
                    <TD>
                      <Badge tone="primary">{kindLabel(t, p.kind)}</Badge>
                    </TD>
                    <TD className="hidden 2xl:table-cell text-muted-foreground">
                      <code className="text-xs">
                        {p.baseUrl || t("admin.searchProviders.defaultEndpoint")}
                      </code>
                      {p.hasApiKey && (
                        <div className="mt-1 text-xs">{t("admin.searchProviders.keySet")}</div>
                      )}
                    </TD>
                    <TD className="hidden 2xl:table-cell text-muted-foreground">{p.priority}</TD>
                    <TD className="text-muted-foreground">
                      {p.creditsPerCall}
                    </TD>
                    <TD className="hidden lg:table-cell">
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
                        {unusable.get(p.id) && (
                          <span
                            className="text-xs text-destructive"
                            title={unusable.get(p.id) ?? ""}
                          >
                            {t("admin.searchProviders.unusable")}
                          </span>
                        )}
                      </div>
                      {unusable.get(p.id) && (
                        <div className="mt-1 max-w-[16rem] text-xs text-destructive">
                          {unusable.get(p.id)}
                        </div>
                      )}
                    </TD>
                    <TD className="text-right">
                      <SearchProviderActions
                        provider={p}
                        templates={TEMPLATE_OPTIONS}
                        isDefault={defaultServiceId === p.serviceId}
                      />
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
            // The resolver's own answer, not a re-read of the environment: the
            // fallback is in use exactly when it says so.
            envConfigured={backend.source === "env"}
          />
        )}
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
