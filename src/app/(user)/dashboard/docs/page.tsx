import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { SectionPageLayout } from "@/components/layouts";
import { IntegrationDocs } from "@/components/docs/IntegrationDocs";
import { USER_DOC_DEFAULT } from "@/lib/docs/sections";
import { ModelCatalog } from "./ModelCatalog";

export const metadata = { title: { absolute: "接入文档 - RelayAB" } };
export const dynamic = "force-dynamic";

export default async function DocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [{ t }, catalog, publicUrl] = await Promise.all([
    getT(),
    cachedBuildModelCatalog(),
    resolvePublicUrl(),
  ]);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("docs.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className="space-y-6">
          {/* Live, not a copy: the facts below are read from the provider
              tables on every request, so this page cannot advertise a model
              the gateway would not serve. */}
          <ModelCatalog
            models={catalog.models}
            providers={catalog.providers}
            site={catalog.site}
            publicUrl={publicUrl}
          />
          <IntegrationDocs basePath="/dashboard/docs" section={USER_DOC_DEFAULT} />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
