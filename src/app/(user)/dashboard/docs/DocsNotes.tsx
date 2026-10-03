/**
 * src/app/(user)/dashboard/docs/DocsNotes.tsx
 *
 * The operator's own prose, rendered where the reader already is.
 *
 * `inline` is the point of the whole feature: a page the operator filed under a
 * built-in chapter appears at the bottom of that chapter, as part of it, with
 * the same reading rhythm as everything above it. `chapter` is the fallback for
 * pages that were not filed anywhere, which get the `notes` chapter of their
 * own — and that chapter only exists when it has something in it.
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

export function DocsNotes({
  pages,
  variant = "inline",
}: {
  pages: readonly DocPage[];
  /** `chapter` introduces the operator's own chapter; `inline` tucks into one. */
  variant?: "inline" | "chapter";
}) {
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
      {variant === "chapter" && (
        <Card>
          <CardHeader title={t("docs.notes.title")} description={t("docs.notes.desc")} />
        </Card>
      )}

      {visible.map((page) => (
        <article
          key={page.id}
          id={page.id}
          className={
            variant === "inline"
              ? // A rule down the left edge, not a box. A box would announce
                // "a different document starts here", which is the opposite of
                // what filing it under this chapter is for.
                "scroll-mt-24 space-y-3 border-l-2 border-primary/30 pl-4"
              : "scroll-mt-24 space-y-3"
          }
        >
          <h2 className="flex items-baseline gap-2 text-base font-semibold tracking-tight text-foreground">
            {page.title}
            <span className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
              {t("docs.notes.badge")}
            </span>
          </h2>
          <div
            className={PROSE}
            dangerouslySetInnerHTML={{ __html: markdownToHtml(page.body) }}
          />
        </article>
      ))}
    </div>
  );
}
