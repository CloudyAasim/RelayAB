/**
 * The admin reference, rendered by the same reader as the user guide.
 *
 * The admin docs used to have their own shell (DocsShell) while the user guide
 * had another (UserDocsApp): two outlines, two copy buttons, two sets of
 * prev/next, and two ideas of how a chapter is opened. They are the same kind
 * of page, so they are now the same component — the admin guide is one guide
 * whose chapters carry their rendered bodies.
 */
import { getT } from "@/lib/i18n/server";
import { UserDocsApp } from "@/components/docs/UserDocsApp";
import { adminDocSections, type AdminDocId } from "@/lib/docs/sections";
import { AdminDocsContent } from "./AdminDocsContent";

export async function AdminDocsScreen({
  section,
  basePath = "/admin/docs",
}: {
  section: AdminDocId;
  basePath?: string;
}) {
  const { t } = await getT();
  const chapters = adminDocSections(t).map((entry) => ({
    ...entry,
    content: <AdminDocsContent section={entry.id as AdminDocId} t={t} />,
  }));

  return (
    <UserDocsApp
      guides={[
        {
          id: "admin",
          label: t("admin.docs.title"),
          chapters,
          pages: [],
        },
      ]}
      initial={section}
      initialPage={null}
      basePath={basePath}
      base=""
      openaiBase=""
      anthropicBase=""
      catalogue={null}
      chapterAnswers={{}}
      guideCountLabel=""
      guidePagesLabel=""
      prevChapterLabel={t("docs.chapter.prev")}
      nextChapterLabel={t("docs.chapter.next")}
      outlineLabel={t("docs.sections")}
      copyPageLabel={t("docs.copyPage")}
      copiedLabel={t("docs.copy.copied")}
      copyFailedLabel={t("docs.copy.failed")}
      searchLabel={t("docs.search")}
      searchPlaceholder={t("docs.searchPlaceholder")}
    />
  );
}
