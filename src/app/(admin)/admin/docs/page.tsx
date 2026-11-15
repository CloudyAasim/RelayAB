import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getT } from "@/lib/i18n/server";
import { SectionPageLayout } from "@/components/layouts";
import { AdminDocsScreen } from "./AdminDocsScreen";
import { ADMIN_DOC_DEFAULT } from "@/lib/docs/sections";

export const dynamic = "force-dynamic";

/** Admin-only operator reference, rendered by the shared docs reader. */
export default async function AdminDocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  const { t } = await getT();

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t("admin.docs.title")}</SectionPageLayout.Title>
      <SectionPageLayout.Description>{t("admin.docs.subtitle")}</SectionPageLayout.Description>
      <SectionPageLayout.Content>
        <AdminDocsScreen section={ADMIN_DOC_DEFAULT} />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  );
}
