import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { DocsShell } from "./DocsShell";
import { userDocSections, type UserDocId } from "@/lib/docs/sections";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";

/**
 * The integration docs body: resolve this deployment's public URLs, then render
 * one section inside the navigable shell. Shared by the public `/docs` surface
 * and the signed-in `/dashboard/docs` surface.
 */
export async function IntegrationDocs({
  basePath,
  section,
}: {
  basePath: string;
  section: UserDocId;
}) {
  const { t } = await getT();
  const base = await resolvePublicUrl();
  const openaiBase = `${base}/v1`;

  return (
    <DocsShell basePath={basePath} sections={userDocSections(t)}>
      <DocsContent
        section={section}
        baseUrl={base}
        openaiBase={openaiBase}
        anthropicBase={`${base}/anthropic`}
        responsesBase={openaiBase}
      />
    </DocsShell>
  );
}
