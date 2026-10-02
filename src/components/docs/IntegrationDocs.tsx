import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { DocsShell } from "./DocsShell";
import { userDocSections, type UserDocId } from "@/lib/docs/sections";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";
import { DocsNotes } from "@/app/(user)/dashboard/docs/DocsNotes";
import { hasVisibleDocPages, NOTES_SECTION } from "@/lib/docs/custom";
import { getSettings } from "@/lib/db/settings";

/**
 * The integration docs body: resolve this deployment's public URLs, then render
 * one section inside the navigable shell. Shared by the public `/docs` surface
 * and the signed-in `/dashboard/docs` surface.
 *
 * The operator's own chapter is passed in rather than read here, because the
 * outline needs to know whether it exists *before* anything renders — an entry
 * pointing at an empty chapter is what makes a custom section look bolted on.
 */
export async function IntegrationDocs({
  basePath,
  section,
  docPages,
}: {
  basePath: string;
  section: UserDocId;
  docPages?: Awaited<ReturnType<typeof getSettings>>["docPages"];
}) {
  const { t } = await getT();
  const base = await resolvePublicUrl();
  const openaiBase = `${base}/v1`;
  const withNotes = hasVisibleDocPages(docPages);

  return (
    <DocsShell
      basePath={basePath}
      sections={userDocSections(t, withNotes ? [NOTES_SECTION] : [])}
      copyPageLabel={t("docs.copyPage")}
      copiedLabel={t("docs.copy.copied")}
      copyFailedLabel={t("docs.copy.failed")}
    >
      {section === NOTES_SECTION && withNotes ? (
        <DocsNotes pages={docPages ?? []} />
      ) : (
        <DocsContent
          section={section}
          baseUrl={base}
          openaiBase={openaiBase}
          anthropicBase={`${base}/anthropic`}
          responsesBase={openaiBase}
        />
      )}
    </DocsShell>
  );
}
