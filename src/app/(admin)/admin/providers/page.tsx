import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders } from "@/lib/db/providers";
import { providerFaces } from "@/lib/db/types";
import { activeModeOf, SURFACES } from "@/lib/protocol/text-specs";
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
 *  - Simple asks *which sides answer, in what upstream format* — the fields
 *    simple mode actually has. It shows one badge per face, with the chosen
 *    format on the OpenAI one. The form itself calls that one side covering
 *    both client endpoints, and splitting it into two badges made a single
 *    switch look like two live things.
 *  - Advanced keeps the surfaces a rule can be written for, each marked when it
 *    has one — unchanged, because a rule is addressed to a surface by name.
 *
 * Marking those endpoints with rules while simple was in effect was advanced's
 * vocabulary in simple's column, so the two branches are separate: neither one
 * reaches for the other's words.
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
  faces,
  textSpecs,
  mode,
  labels,
}: {
  faces: ReturnType<typeof providerFaces>;
  textSpecs: string[];
  mode: "simple" | "advanced";
  labels: {
    none: string;
    hasRule: string;
    openaiSide: string;
    anthropicSide: string;
    /**
     * Pre-bound rather than a template: the count is only knowable inside this
     * cell, and doing the `{n}` substitution here would mean re-implementing the
     * interpreter the server's `t` already has. The call site binds it, so
     * translation still happens in one place.
     */
    parkedRules: (n: number) => string;
    chat: string;
    responses: string;
  };
}) {
  const { openai, anthropic } = faces;
  if (!openai && !anthropic) {
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
   * Simple's answer, in simple's own words: the faces it configures.
   *
   * The format rides on the OpenAI badge because that is where the form puts it
   * — a sub-select under the OpenAI switch, not a property of either endpoint.
   * Splitting the side into its two client endpoints and labelling one of them
   * made a single switch look like two live things, which is the reading this
   * column used to give.
   */
  if (!advanced) {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-1">
          {openai && (
            <Badge tone="info">
              {labels.openaiSide}
              <span className="ml-1 opacity-70">
                · {openai.format === "chat" ? labels.chat : labels.responses}
              </span>
            </Badge>
          )}
          {anthropic && <Badge tone="orange">{labels.anthropicSide}</Badge>}
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
   * Advanced's answer: the surfaces a rule can be written for, each marked when
   * it has one, exactly as this column has always shown them.
   *
   * A surface with no rule gets nothing — "no policy" is the default state, and
   * marking it would make every provider look configured. The face switches
   * still gate which surfaces appear, because that predates the modes and is
   * what "what this provider actually answers" means here.
   */
  const ruleMark = (protocol: string) =>
    hasRule(protocol) ? (
      <span className="ml-1 opacity-70">· {labels.hasRule}</span>
    ) : null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {openai && (
        <Badge tone="info">
          /v1/chat/completions
          <span className="ml-1 opacity-70">
            {openai.format === "chat" ? labels.chat : labels.responses}
          </span>
          {ruleMark("openai-chat")}
        </Badge>
      )}
      {openai && (
        <Badge tone="info">
          /v1/responses
          {ruleMark("openai-responses")}
        </Badge>
      )}
      {anthropic && (
        <Badge tone="orange">
          /anthropic/v1/messages
          {ruleMark("anthropic-messages")}
        </Badge>
      )}
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
      <SectionPageLayout.Actions>
        <CreateProviderButton />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
      <Card>
        {providers.length === 0 ? (
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title={t("admin.providers.empty.title")}
            description={t("admin.providers.create.desc")}
            action={<CreateProviderButton />}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t("admin.providers.create.name")}</TH>
                <TH>{t("admin.providers.table.interfaces")}</TH>
                <TH>{t("admin.providers.create.baseUrl")}</TH>
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
                      faces={providerFaces(p)}
                      textSpecs={p.textSpecs ?? []}
                      mode={activeModeOf(p)}
                      labels={{
                        none: t("admin.providers.table.noInterface"),
                        hasRule: t("admin.providers.table.hasRule"),
                        openaiSide: t("admin.providers.table.openaiSide"),
                        anthropicSide: t("admin.providers.table.anthropicSide"),
                        parkedRules: (n: number) => t("admin.providers.table.parkedRules", { n }),
                        chat: t("admin.providers.format.short.chat"),
                        responses: t("admin.providers.format.short.responses"),
                      }}
                    />
                  </TD>
                  <TD className="text-muted-foreground">
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
