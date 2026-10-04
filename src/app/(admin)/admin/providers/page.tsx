import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders } from "@/lib/db/providers";
import { providerFaces } from "@/lib/db/types";
import { activeModeOf } from "@/lib/protocol/text-specs";
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
 * So it says what is actually served, per interface, and marks which of them
 * have a rule *in effect*. That is the question both modes are asking: simple —
 * which endpoints answer; advanced — and how their parameters are handled. A
 * provider with both sides off is called out rather than shown as two dashes,
 * because it is unreachable, not empty.
 *
 * **The rule marker follows `activeModeOf`, not `textSpecs`.** Marking from the
 * stored list alone was a statement about the database, not about the traffic:
 * a provider switched to simple still holds every rule it was given, so the
 * column kept advertising three of them while none was running. The stored-but-
 * inactive case now says so in its own words, which is also the answer to "did
 * switching delete my config" — it did not, and here is where it went.
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
  labels: { none: string; hasRule: string; rulesOff: string; chat: string; responses: string };
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

  /**
   * One marker per surface, and which of the two it is depends on the mode. A
   * surface with no rule at all gets nothing — "no policy" is the default state
   * and marking it would make every provider look configured.
   */
  const ruleMark = (protocol: string) => {
    if (!hasRule(protocol)) return null;
    return mode === "advanced" ? (
      <span className="ml-1 opacity-70">· {labels.hasRule}</span>
    ) : (
      <span className="ml-1 text-amber-700/80 dark:text-amber-400/80">
        · {labels.rulesOff}
      </span>
    );
  };

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
                        rulesOff: t("admin.providers.table.rulesOff"),
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
