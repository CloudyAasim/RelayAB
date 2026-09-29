/**
 * app/(admin)/admin/docs/page.tsx
 *
 * Admin-only operator reference, split into one page per topic.
 *
 * Kept separate from the user-facing /docs page: that one explains how to call
 * the API, this one explains how to *run* it (provider wiring, metering,
 * media providers, troubleshooting). Access is enforced by the /admin segment
 * layout, which redirects non-admins before anything renders.
 */
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { DocsShell } from "@/components/docs/DocsShell";
import { AdminDocsContent } from "./AdminDocsContent";
import { ADMIN_DOC_DEFAULT, adminDocSections } from "@/lib/docs/sections";

export const dynamic = "force-dynamic";

export default async function AdminDocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
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
          <AdminDocsContent section={ADMIN_DOC_DEFAULT} t={t} />
        </DocsShell>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
