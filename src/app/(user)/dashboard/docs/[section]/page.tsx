import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { IntegrationDocs } from "@/components/docs/IntegrationDocs";
import { getSettings } from "@/lib/db/settings";
import { USER_DOC_DEFAULT, isUserDocId } from "@/lib/docs/sections";

export const metadata = { title: { absolute: "接入文档 - RelayAB" } };

export default async function DocsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { section } = await params;
  // Streams (the dashboard has a loading boundary), so a thrown notFound()
  // would produce a soft 404. Send stale/typo'd slugs back to the index.
  if (!isUserDocId(section)) redirect(`/dashboard/docs/${USER_DOC_DEFAULT}`);
  const [{ t }, { docPages }] = await Promise.all([getT(), getSettings()]);

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("docs.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <IntegrationDocs basePath="/dashboard/docs" section={section} docPages={docPages} />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
