import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { Card } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import {
  AuthenticatedLayout,
  SectionPageLayout,
} from "@/components/layouts";
import { DocsContent } from "./DocsContent";

export default async function DocsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { t } = await getT();

  const base = await resolvePublicUrl();
  const openaiBase = `${base}/v1`;
  const anthropicBase = `${base}/anthropic`;
  const responsesBase = `${base}/v1`;

  return (
    <AuthenticatedLayout
      role={user.role}
      username={user.username}
      displayName={user.displayName}
      pageTitle={t("docs.title")}
    >
      <SectionPageLayout>
        <SectionPageLayout.Title>{t("docs.title")}</SectionPageLayout.Title>
        <SectionPageLayout.Content>
          <DocsContent
            baseUrl={base}
            openaiBase={openaiBase}
            anthropicBase={anthropicBase}
            responsesBase={responsesBase}
          />
        </SectionPageLayout.Content>
      </SectionPageLayout>
    </AuthenticatedLayout>
  );
}
