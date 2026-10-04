import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { cachedBuildModelCatalog } from "@/lib/db/data-cache";
import { getSettings } from "@/lib/db/settings";
import { SectionPageLayout } from "@/components/layouts";
import { IntegrationDocs } from "@/components/docs/IntegrationDocs";
import { ModelCatalog } from "@/components/docs/ModelCatalog";

/**
 * The signed-in docs screen, shared by the index and every chapter.
 *
 * Live, not a copy: the catalogue below is read from the provider tables on
 * every request, so this page cannot advertise a model the gateway would not
 * serve. It sits above the tabs rather than inside one, because it answers
 * "what can I call here" and that is not any one chapter's question.
 */
export async function UserDocsScreen({
  basePath,
  section,
  initialPage = null,
}: {
  basePath: string;
  section: string;
  /** Which page of the parameters guide a deep link names, if any. */
  initialPage?: string | null;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const [{ t }, catalog, publicUrl, { docPages }] = await Promise.all([
    getT(),
    cachedBuildModelCatalog(),
    resolvePublicUrl(),
    getSettings(),
  ]);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("docs.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <IntegrationDocs
          basePath={basePath}
          section={section}
          initialPage={initialPage}
          docPages={docPages}
          catalogue={
            <ModelCatalog
              models={catalog.models}
              providers={catalog.providers}
              site={catalog.site}
              publicUrl={publicUrl}
            />
          }
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
