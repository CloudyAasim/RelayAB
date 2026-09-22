import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { listProviders } from "@/lib/db/providers";
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
import { AuthenticatedLayout, SectionPageLayout } from "@/components/layouts";
import { Server } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const providers = await listProviders();

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("admin.providers.title")}
    >
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
                  <TH>{t("admin.providers.table.kind")}</TH>
                  <TH>{t("admin.providers.table.format")}</TH>
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
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                        {p.kind}
                      </code>
                    </TD>
                    <TD>
                      <Badge tone={p.upstreamFormat === "anthropic" ? "orange" : "neutral"}>
                        {p.upstreamFormat === "anthropic"
                          ? t("admin.providers.format.anthropic")
                          : p.upstreamFormat === "chat"
                            ? t("admin.providers.format.short.chat")
                            : t("admin.providers.format.short.responses")}
                      </Badge>
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
    </AuthenticatedLayout>
  );
}
