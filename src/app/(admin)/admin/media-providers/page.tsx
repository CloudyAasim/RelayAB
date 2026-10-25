/**
 * app/(admin)/admin/media-providers/page.tsx
 *
 * Media providers, listed the same way as chat providers: one collapsed row
 * each, with the full editor (base URL, models, specs) behind the row actions.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listMediaProviders, toPublicMediaProvider } from "@/lib/db/media-providers";
import { MEDIA_TEMPLATES } from "@/lib/media/seeds";
import { servedCapabilities } from "@/lib/media/spec";
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
import { CreateMediaProviderButton } from "./CreateMediaProviderButton";
import { MediaProviderActions } from "./MediaProviderActions";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { Image as ImageIcon } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function MediaProvidersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const providers = (await listMediaProviders()).map(toPublicMediaProvider);
  const templates = Object.entries(MEDIA_TEMPLATES).map(([id, template]) => ({
    id,
    name: template.name,
    baseUrl: template.baseUrl,
    models: template.models,
    specs: template.specs,
  }));

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.mediaProviders.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>
        {t("admin.mediaProviders.description")}
      </SectionPageLayout.Description>
      <SectionPageLayout.Actions>
        <CreateMediaProviderButton templates={templates} />
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        {/*
          No paragraph under the header: the description above already says it.
          It used to be rendered twice — once as the page's description and once
          here, the same sentence, a line apart.
        */}
        <Card>
          {providers.length === 0 ? (
            <EmptyState
              icon={<ImageIcon className="h-5 w-5" />}
              title={t("admin.mediaProviders.empty")}
              description={t("admin.mediaProviders.empty.description")}
              action={<CreateMediaProviderButton templates={templates} />}
            />
          ) : (
            <Table bare>
              <THead>
                <TR>
                  <TH>{t("admin.mediaProviders.name")}</TH>
                  <TH>{t("admin.mediaProviders.capabilities")}</TH>
                  <TH>{t("admin.mediaProviders.baseUrl")}</TH>
                  <TH>{t("admin.providers.table.models")}</TH>
                  <TH>{t("dashboard.table.status")}</TH>
                  <TH className="w-32 text-right">{t("common.actions")}</TH>
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
                      {p.specs.length === 0 ? (
                        <Badge tone="neutral">—</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {/*
                            One badge per capability, not per spec. A provider
                            may hold two specs of the same capability — a vendor
                            that ships a v1 and a v2 API — and listing the specs
                            one by one printed the same capability twice, side
                            by side, with nothing to tell them apart.
                          */}
                          {servedCapabilities(p.specs).map((served) => (
                            <Badge
                              key={served.capability}
                              tone="primary"
                              title={
                                served.models.length > 0
                                  ? `${served.models.join("、")}`
                                  : undefined
                              }
                            >
                              {served.capability}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TD>
                    <TD className="text-muted-foreground">
                      <code className="text-xs">{p.baseUrl || "—"}</code>
                    </TD>
                    <TD className="text-muted-foreground">
                      {t("common.models", { count: Object.keys(p.models).length })}
                    </TD>
                    <TD>
                      <Badge tone={p.enabled ? "success" : "neutral"}>
                        {p.enabled
                          ? t("dashboard.status.enabled")
                          : t("dashboard.status.disabled")}
                      </Badge>
                    </TD>
                    <TD className="text-right">
                      <MediaProviderActions provider={p} />
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
