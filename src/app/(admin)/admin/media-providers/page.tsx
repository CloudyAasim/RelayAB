import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

import { getCurrentUser } from "@/lib/auth/session";
import { listMediaProviders, toPublicMediaProvider } from "@/lib/db/media-providers";
import { MEDIA_TEMPLATES } from "@/lib/media/seeds";
import { getT } from "@/lib/i18n/server";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { SectionPageLayout } from "@/components/layouts";
import { MediaProviderForm } from "./MediaProviderForm";
import { Image as ImageIcon } from "lucide-react";

export default async function MediaProvidersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const { t } = await getT();
  const providers = (await listMediaProviders()).map(toPublicMediaProvider);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.mediaProviders.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("admin.mediaProviders.description")}
        </p>

        {providers.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("admin.mediaProviders.empty")}
          </p>
        ) : (
          <div className="space-y-4">
            {providers.map((provider) => (
              <Card key={provider.id}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <ImageIcon className="h-4 w-4 text-muted-foreground" />
                      {provider.name}
                      <Badge tone={provider.enabled ? "success" : "neutral"}>
                        {provider.enabled ? t("dashboard.status.enabled") : t("dashboard.status.disabled")}
                      </Badge>
                      {provider.specs.map((spec) => (
                        <Badge key={spec.capability} tone="primary">
                          {spec.capability}
                        </Badge>
                      ))}
                    </span>
                  }
                  description={provider.baseUrl}
                />
                <MediaProviderForm provider={provider} />
              </Card>
            ))}
          </div>
        )}

        <Card className="mt-6">
          <CardHeader title={t("admin.mediaProviders.new")} />
          <MediaProviderForm
            templates={Object.entries(MEDIA_TEMPLATES).map(([id, template]) => ({
              id,
              name: template.name,
              baseUrl: template.baseUrl,
              models: template.models,
              specs: template.specs,
            }))}
          />
        </Card>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
