/**
 * src/app/(user)/dashboard/docs/DocsNotes.tsx
 *
 * The operator's own chapter: whatever the administrator wrote, rendered as one
 * page at the end of the reader-facing docs.
 *
 * It is markdown, put through the same escaping path as the built-in pages —
 * `markdownToHtml` escapes before it emits anything — so an admin writing prose
 * cannot introduce markup that runs.
 */
import { Card, CardHeader } from "@/components/ui/Card";
import { getT } from "@/lib/i18n/server";
import { markdownToHtml } from "@/lib/markdown";
import { sortDocPages, type DocPage } from "@/lib/docs/custom";

export async function DocsNotes({ pages }: { pages: DocPage[] }) {
  const { t } = await getT();
  const visible = sortDocPages(pages).filter((p) => !p.hidden);

  // Reached with nothing to show only by typing the url; the outline entry is
  // absent in that case, and this says why rather than rendering a blank page.
  if (visible.length === 0) {
    return (
      <Card>
        <CardHeader title={t("docs.notes.title")} description={t("docs.notes.desc")} />
        <p className="text-sm text-muted-foreground">{t("docs.notes.empty")}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title={t("docs.notes.title")} description={t("docs.notes.desc")} />
      </Card>

      {visible.map((page) => (
        <article key={page.id} id={page.id} className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{page.title}</h2>
          <div
            className="prose prose-sm max-w-none break-words text-foreground prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-pre:my-3 prose-pre:bg-foreground/[0.03] prose-code:before:content-none prose-code:after:content-none prose-a:text-primary"
            dangerouslySetInnerHTML={{ __html: markdownToHtml(page.body) }}
          />
        </article>
      ))}
    </div>
  );
}
