import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { DocsShell } from "@/components/docs/DocsShell";
import { AdminDocsContent } from "../AdminDocsContent";
import {
  ADMIN_DOC_DEFAULT,
  adminDocSections,
  isAdminDocId,
} from "@/lib/docs/sections";

export const dynamic = "force-dynamic";

export default async function AdminDocsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const { section } = await params;
  // This route streams (the /admin segment has a loading boundary), so a thrown
  // notFound() would render the 404 body with an already-sent 200. Send people
  // back to the docs index instead — a stale slug is a bookmark, not an error.
  if (!isAdminDocId(section)) redirect(`/admin/docs/${ADMIN_DOC_DEFAULT}`);
  const { t } = await getT();

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.docs.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <DocsShell
          basePath="/admin/docs"
          sections={adminDocSections(t)}
          copyPageLabel={t("docs.copyPage")}
          copiedLabel={t("docs.copy.copied")}
          copyFailedLabel={t("docs.copy.failed")}
        >
          <AdminDocsContent section={section} t={t} />
        </DocsShell>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
