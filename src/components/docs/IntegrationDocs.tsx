import { getT } from "@/lib/i18n/server";
import { resolvePublicUrl } from "@/lib/public-url";
import { DocsShell } from "./DocsShell";
import type { UserDocId } from "@/lib/docs/sections";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";
import { DocsNotes } from "@/app/(user)/dashboard/docs/DocsNotes";
import { NOTES_SECTION, pagesForSection, userDocOutline } from "@/lib/docs/custom";
import { getSettings } from "@/lib/db/settings";

/**
 * The integration docs body: resolve this deployment's public URLs, then render
 * one section inside the navigable shell. Shared by the public `/docs` surface
 * and the signed-in `/dashboard/docs` surface.
 *
 * The operator's own pages are passed in rather than read here, because the
 * outline needs to know what exists *before* anything renders — a chapter
 * heading with nothing under it is what makes a custom section look bolted on.
 *
 * A page filed under this chapter renders at the bottom of it, inside the same
 * page as the built-in prose. That is the difference between the operator's
 * documentation being part of the document and being an appendix to it.
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
  const here = pagesForSection(docPages, section);

  return (
    <DocsShell
      basePath={basePath}
      sections={userDocOutline(t, docPages)}
      copyPageLabel={t("docs.copyPage")}
      copiedLabel={t("docs.copy.copied")}
      copyFailedLabel={t("docs.copy.failed")}
    >
      {section === NOTES_SECTION ? (
        <DocsNotes pages={here} variant="chapter" />
      ) : (
        <>
          <DocsContent
            section={section}
            baseUrl={base}
            openaiBase={openaiBase}
            anthropicBase={`${base}/anthropic`}
            responsesBase={openaiBase}
          />
          {here.length > 0 && <DocsNotes pages={here} />}
        </>
      )}
    </DocsShell>
  );
}
