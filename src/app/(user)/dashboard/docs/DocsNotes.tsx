/**
 * src/app/(user)/dashboard/docs/DocsNotes.tsx
 *
 * The operator's own chapter: whatever the administrator wrote, in reading
 * order, as one page at the end of the reader-facing docs.
 *
 * All of it lives here rather than being filed into the built-in chapters. The
 * version that let each page name its own chapter scattered the operator's
 * prose through the document, and a reader looking for the rate limit then had
 * to know which chapter somebody had put it in. One chapter, one place.
 *
 * It is markdown, put through the same escaping path as the built-in pages —
 * `markdownToHtml` escapes before it emits anything — so an admin writing prose
 * cannot introduce markup that runs.
 *
 * A client component, like `DocsContent` beside it: it reads the dictionary
 * through `useT`, and a server component calling a client hook throws at render
 * time rather than at build time. The whole chapter silently 500s, which is a
 * bad way to find out.
 */
"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import { useT } from "@/components/i18n/I18nProvider";
import { markdownToHtml } from "@/lib/markdown";
import { sortDocPages, type DocPage } from "@/lib/docs/custom";

const PROSE =
  "prose prose-sm max-w-none break-words text-foreground prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-pre:my-3 prose-pre:bg-foreground/[0.03] prose-code:before:content-none prose-code:after:content-none prose-a:text-primary";

export function DocsNotes({ pages }: { pages: readonly DocPage[] }) {
  const t = useT();
  const visible = sortDocPages(pages).filter((p) => !p.hidden);

  // The chapter is only in the outline when it has pages, so arriving here with
  // none means the url was typed. Say so rather than rendering a blank page.
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
        <article key={page.id} id={page.id} className="scroll-mt-24 space-y-3">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{page.title}</h2>
          <div
            className={PROSE}
            dangerouslySetInnerHTML={{ __html: markdownToHtml(page.body) }}
          />
        </article>
      ))}
    </div>
  );
}
