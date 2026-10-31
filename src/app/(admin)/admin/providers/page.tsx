import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders } from "@/lib/db/providers";
import { activeModeOf, SURFACES } from "@/lib/protocol/text-specs";
import { routesOf, type SurfaceRoute, type SurfaceRoutes } from "@/lib/protocol/surface-routes";
import { Card } from "@/components/ui/Card";
import {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { CreateProviderButton } from "./CreateProviderButton";
import { ProviderActions } from "./ProviderActions";
import { getT } from "@/lib/i18n/server";
import type { Provider } from "@/lib/db/types";

/**
 * What this provider answers, in one column.
 *
 * The table used to show `kind` — the value a row was *typed* as — beside a
 * pair of format badges. After the two modes, `kind` is not the routing truth:
 * a row saved as `openai` with the OpenAI side switched off served nothing on
 * OpenAI while the table said "openai". A list that can state a falsehood is
 * worse than a list that says less.
 *
 * **The column answers the live configuration's question, in that mode's own
 * words.** They are two different questions and they are not the same list:
 *
 *  - Simple asks *which client interfaces answer, and how* — the route table
 *    row by row. It shows one badge per served interface: not served is left
 *    out, passed through says so, and routed says which dialect it is
 *    rewritten into.
 *  - Advanced keeps the same list and marks the interfaces a rule is written
 *    for — unchanged, because a rule is addressed to an interface by name.
 *
 * Marking those endpoints with rules while simple was in effect was advanced's
 * vocabulary in simple's column, so the two branches are separate: neither one
 * reaches for the other's words.
 *
 * **The list comes from the route table, not from the face flags.** The flags
 * are the table's summary — one dialect for three interfaces — and the summary
 * cannot say the thing that matters now: a Gemini vendor whose own endpoint
 * takes the request as it arrived is not "translated to Gemini", and a badge
 * that says so would be wrong rather than merely old.
 *
 * The branch follows `activeModeOf`, not `textSpecs`, because a provider
 * switched to simple still holds every rule it was given, and the column would
 * then be describing the database rather than the traffic. Whether anything is
 * parked gets one quiet line underneath simple's badges, because a provider
 * whose rules were switched off and one that never had any are otherwise
 * identical, and "did I lose it" is the first question that follows choosing
 * simple.
 *
 * The labels arrive as props. This file is a server component — it reads the
 * session and the providers — so it cannot reach for a client-side translation
 * hook to get them, and a cell defined here that tried would fail the build on
 * the client/server boundary rather than on anything to do with translation.
 */
function InterfaceCell({
  routes,
  textSpecs,
  mode,
  labels,
}: {
  routes: SurfaceRoutes;
  textSpecs: string[];
  mode: "simple" | "advanced";
  labels: {
    none: string;
    hasRule: string;
    /** The four client interfaces, by their short names. */
    chat: string;
    responses: string;
    anthropic: string;
    gemini: string;
    /** How an interface is answered. */
    passthrough: string;
    routedTo: (dialect: string) => string;
    /**
     * Pre-bound rather than a template: the count is only knowable inside this
     * cell, and doing the `{n}` substitution here would mean re-implementing the
     * interpreter the server's `t` already has. The call site binds it, so
     * translation still happens in one place.
     */
    parkedRules: (n: number) => string;
  };
}) {
  /** The short name of each client interface, in the order the editor lists them. */
  const surfaceLabel: Record<string, string> = {
    "openai-chat": labels.chat,
    "openai-responses": labels.responses,
    "anthropic-messages": labels.anthropic,
    "gemini-generate": labels.gemini,
  };

  /** The interfaces this provider answers, and how it answers each one. */
  const served = SURFACES.map((surface) => ({ surface, route: routes[surface.id] })).filter(
    (entry) => entry.route.kind !== "unsupported",
  );
  if (served.length === 0) {
    return <Badge tone="warning">{labels.none}</Badge>;
  }

  const hasRule = (protocol: string) =>
    textSpecs.some((raw) => {
      try {
        return (JSON.parse(raw) as { protocol?: string }).protocol === protocol;
      } catch {
        return false;
      }
    });

  const advanced = mode === "advanced";

  /**
   * How many interfaces have a rule stored, counted the way the row is read:
   * by protocol, not by array length. `textSpecs` holds raw JSON strings, so its
   * length counts an unparseable draft and a duplicate just as readily as a rule
   * the proxy would actually apply.
   */
  const parked = advanced
    ? 0
    : SURFACES.filter((s) => hasRule(s.id)).length;

  /**
   * How one interface is answered, in the words the route table uses.
   *
   * Three answers, and the third one names the dialect: a row routed to
   * another dialect has no upstream protocol of its own to name, and printing
   * the vendor's protocol for it would describe a request the gateway never
   * makes.
   */
  const answerOf = (route: SurfaceRoute): string =>
    route.kind === "passthrough"
      ? labels.passthrough
      : route.kind === "route"
        ? labels.routedTo(route.dialect)
        : "";

  /**
   * Simple's answer, in simple's own words: the client interfaces it answers.
   *
   * The badges are the route table's own rows, so the column says the same
   * thing the form does — which is the whole reason it exists.
   */
  if (!advanced) {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-1">
          {served.map(({ surface, route }) => (
            <Badge key={surface.id} tone="info">
              {surfaceLabel[surface.id]}
              <span className="ml-1 opacity-70">· {answerOf(route)}</span>
            </Badge>
          ))}
        </div>
        {/*
          One line, and only when something is actually parked. Without it a
          provider whose rules were switched off looks exactly like one that
          never had any — and the whole reason the rules are kept is that
          somebody is going to want them back.
        */}
        {parked > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">
            {labels.parkedRules(parked)}
          </div>
        )}
      </div>
    );
  }

  /**
   * Advanced's answer: the same interfaces, each marked when a rule is written
   * for it.
   *
   * An interface with no rule gets nothing — "no policy" is the default state,
   * and marking it would make every provider look configured.
   */
  const ruleMark = (protocol: string) =>
    hasRule(protocol) ? (
      <span className="ml-1 opacity-70">· {labels.hasRule}</span>
    ) : null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {served.map(({ surface, route }) => (
        <Badge key={surface.id} tone="info">
          {surfaceLabel[surface.id]}
          <span className="ml-1 opacity-70">· {answerOf(route)}</span>
          {ruleMark(surface.id)}
        </Badge>
      ))}
    </div>
  );
}
import { SectionPageLayout } from "@/components/layouts";
import { Server } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const providers = await listProviders();

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.providers.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("admin.providers.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Actions>
        <CreateProviderButton />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
      <Card>
        {providers.length === 0 ? (
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title={t("admin.providers.empty.title")}
            description={t("admin.providers.empty.description")}
            action={<CreateProviderButton />}
          />
        ) : (
          <Table bare>
            <THead>
              <TR>
                <TH>{t("admin.providers.create.name")}</TH>
                <TH>{t("admin.providers.table.interfaces")}</TH>
                {/* The address is the longest string in the row, and on a
                    narrow screen it is the one the operator can read again in
                    the edit form. The interfaces are what the list is for. */}
                <TH className="hidden lg:table-cell">{t("admin.providers.create.baseUrl")}</TH>
                <TH>{t("admin.providers.table.models")}</TH>
                <TH>{t("dashboard.table.status")}</TH>
                <TH className="w-56 text-right">{t("common.actions")}</TH>
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
                    {/*
                      What this provider answers, not what it was typed as.
                      */}
                    <InterfaceCell
                      routes={routesOf(p)}
                      textSpecs={p.textSpecs ?? []}
                      mode={activeModeOf(p)}
                      labels={{
                        none: t("admin.providers.table.noInterface"),
                        hasRule: t("admin.providers.table.hasRule"),
                        parkedRules: (n: number) => t("admin.providers.table.parkedRules", { n }),
                        chat: t("admin.providers.format.short.chat"),
                        responses: t("admin.providers.format.short.responses"),
                        anthropic: t("admin.providers.format.short.anthropic"),
                        gemini: t("admin.providers.format.short.gemini"),
                        passthrough: t("admin.providers.table.passthrough"),
                        routedTo: (dialect: string) =>
                          t("admin.providers.table.routedTo", { dialect }),
                      }}
                    />
                  </TD>
                  <TD className="hidden lg:table-cell text-muted-foreground">
                    <code className="text-xs">{p.baseUrl || "—"}</code>
                  </TD>
                  <TD className="text-muted-foreground">
                    {t("common.models", { count: Object.keys(p.modelMapping).length })}
                  </TD>
                  <TD>
                    <Badge tone={p.enabled ? "success" : "neutral"}>
                      {p.enabled
                        ? t("dashboard.status.enabled")
                        : t("dashboard.status.disabled")}
                    </Badge>
                  </TD>
                  <TD className="text-right">
                    <ProviderActions providerId={p.id} providerName={p.name} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
