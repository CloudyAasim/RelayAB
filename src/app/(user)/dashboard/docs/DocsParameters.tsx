/**
 * src/app/(user)/dashboard/docs/DocsParameters.tsx
 *
 * The parameters guide: the operator's own reference, one page at a time.
 *
 * **Why it pages.** It used to render every page in the chapter as one long
 * column, which is fine for two pages and unusable for twenty-four. A 327-row
 * voice table pushed everything above it off the screen, and a reader who wanted
 * the Korean voices had to scroll past the Portuguese ones to find out whether
 * there were any. Paging also gives each page a URL, so "the voice list" is
 * something you can send somebody.
 *
 * The order is the reading order `sortDocPages` already decided, so the prev/next
 * pair and the page list can never disagree about what comes next — they read
 * the same array.
 *
 * It is markdown, put through the same escaping path as the built-in pages —
 * `markdownToHtml` escapes before it emits anything — so an admin writing prose
 * cannot introduce markup that runs.
 *
 * A client component, like `DocsContent` beside it: it reads the dictionary
 * through `useT`, and a server component calling a client hook throws at render
 * time rather than at build time. The whole guide silently 500s, which is a bad
 * way to find out.
 */
"use client";

import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useT } from "@/components/i18n/I18nProvider";
import { markdownToHtml } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { DocPage } from "@/lib/docs/custom";

const PROSE =
  "prose prose-sm max-w-none break-words text-foreground prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-pre:my-3 prose-pre:bg-foreground/[0.03] prose-code:before:content-none prose-code:after:content-none prose-a:text-primary prose-table:block prose-table:overflow-x-auto";

export function DocsParameters({
  pages,
  activeId,
  onSelect,
}: {
  pages: readonly DocPage[];
  /** The page on screen. Always one of `pages`; the caller resolves it. */
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useT();

  // Only reachable by typing the url: the guide is not in the outline at all
  // when there is nothing in it. Say so rather than rendering a blank column.
  if (pages.length === 0) {
    return (
      <Card>
        <CardHeader title={t("docs.notes.title")} description={t("docs.notes.desc")} />
        <p className="text-sm text-muted-foreground">{t("docs.notes.empty")}</p>
      </Card>
    );
  }

  const at = Math.max(
    0,
    pages.findIndex((p) => p.id === activeId),
  );
  const page = pages[at];
  const prev = at > 0 ? pages[at - 1] : null;
  const next = at < pages.length - 1 ? pages[at + 1] : null;

  return (
    <div className="space-y-4">
      {/*
        The page list, not just prev/next. A 24-page guide navigated only by
        "previous" is a linear walk with no way to jump, and the whole reason
        for splitting it out of the integration guide was that people come here
        looking for one specific value.
      */}
      <nav
        aria-label={t("docs.notes.title")}
        className="-mx-1 flex flex-wrap gap-1 px-1 pb-1"
      >
        {pages.map((p, i) => {
          const on = p.id === page.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "max-w-[14rem] truncate rounded-md px-2.5 py-1 text-xs transition-colors",
                on
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              title={p.title}
            >
              {i + 1}. {p.title}
            </button>
          );
        })}
      </nav>

      <article id={page.id} className="scroll-mt-24 space-y-3">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{page.title}</h2>
        <div
          className={PROSE}
          dangerouslySetInnerHTML={{ __html: markdownToHtml(page.body) }}
        />
      </article>

      {/*
        Prev/next as well as the list. The list is for arriving at a page you
        know the name of; these are for reading through, and they are the only
        affordance that says how much is left.
      */}
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!prev}
          onClick={() => prev && onSelect(prev.id)}
        >
          <ChevronLeft className="mr-1 h-3.5 w-3.5" />
          {prev ? prev.title : t("docs.notes.prev")}
        </Button>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("docs.notes.pageLabel", { n: at + 1, total: pages.length })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!next}
          onClick={() => next && onSelect(next.id)}
        >
          {next ? next.title : t("docs.notes.next")}
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
