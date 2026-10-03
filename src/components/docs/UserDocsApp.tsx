"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Check, Copy } from "lucide-react";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";
import { DocsNotes } from "@/app/(user)/dashboard/docs/DocsNotes";
import { pagesBySection, type DocPage } from "@/lib/docs/custom";
import type { DocSection, UserDocId } from "@/lib/docs/sections";

/**
 * The reader-facing documentation, as one page with tabs.
 *
 * **Why tabs and not pages.** Every chapter used to be its own route, so moving
 * between them was a navigation: a server round trip, a loading boundary, and
 * whatever the router had already fetched. The operator's own pages are rendered
 * from the settings table, which made that visible — a page filed under one
 * chapter was on that chapter and nowhere else, so it read as "it disappeared"
 * the moment you looked at a neighbouring one, and a full reload did not bring
 * it back either. The data was never gone; the navigation was the problem.
 *
 * So the whole document is loaded once and switching is local state. There is
 * no request to be stale, nothing to prefetch, and nothing to wait for — which
 * removes the entire class of bug rather than one instance of it.
 *
 * The url still tracks the tab, with `replaceState`, so a link to a chapter is
 * still a link to a chapter. It just no longer causes a navigation.
 */
export function UserDocsApp({
  sections,
  initial,
  basePath,
  base,
  openaiBase,
  anthropicBase,
  responsesBase,
  pages,
  catalogue,
  outlineLabel,
  copyPageLabel,
  copiedLabel,
  copyFailedLabel,
}: {
  sections: DocSection[];
  /** From the route, so a deep link opens the right tab. */
  initial: string;
  basePath: string;
  base: string;
  openaiBase: string;
  anthropicBase: string;
  responsesBase: string;
  pages: readonly DocPage[];
  /**
   * The live model catalogue, when this deployment shows one.
   *
   * Above the tabs rather than inside one of them, and therefore on every
   * route: it used to live on the index page, which meant it was on screen
   * until the first chapter switch and gone after it. It is the answer to "what
   * can I actually call here", so it cannot belong to a chapter.
   */
  catalogue?: ReactNode;
  outlineLabel: string;
  copyPageLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}) {
  // A deep link can name a chapter this deployment has nothing to show — the
  // operator's chapter, before they wrote anything in it. Land on the first
  // real chapter rather than an empty tab.
  const first = sections[0]?.id ?? "start";
  const [active, setActive] = useState<string>(
    sections.some((s) => s.id === initial) ? initial : first,
  );
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Back/forward moves between chapters; the tab has to follow.
  useEffect(() => {
    const sync = () => {
      const slug = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
      setActive((current) => (sections.some((s) => s.id === slug) ? slug : current));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [sections]);

  function select(id: string) {
    setActive(id);
    // Shareable, but not a navigation. `pushState` would put every tab in the
    // history and make the back button walk the document.
    window.history.replaceState(null, "", `${basePath}/${id}`);
    bodyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function copyPage() {
    const body = bodyRef.current;
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body.innerText.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // eslint-disable-next-line no-alert
      alert(copyFailedLabel);
    }
  }

  // Grouped by the same helper the outline is built from, so the dot on a tab
  // and the prose under it can never disagree about where a page went.
  const here = pagesBySection(pages).get(active) ?? [];
  const section = active as UserDocId;

  return (
    <div className="space-y-6">
      {catalogue}

      <div className="space-y-5">
      {/*
        The outline, as tabs.

        A count, not a dot. The question a reader actually has is "where did the
        operator's page go", and a bare dot answers "something is here" without
        saying how much — which sends them opening every chapter anyway. The
        number is on the tab they are looking at, before they click anything.
      */}
      <div
        role="tablist"
        aria-label={outlineLabel}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {sections.map((s) => {
          const on = s.id === active;
          const count = s.children?.length ?? 0;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => select(s.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                on
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {s.label}
              {count > 0 && (
                <span
                  aria-label={s.children!.map((c) => c.label).join(", ")}
                  title={s.children!.map((c) => c.label).join("、")}
                  className="ml-1.5 rounded-full bg-primary/15 px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none text-primary"
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button type="button" size="sm" variant="secondary" onClick={copyPage}>
          {copied ? (
            <>
              <Check className="mr-1 h-3.5 w-3.5" />
              {copiedLabel}
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3.5 w-3.5" />
              {copyPageLabel}
            </>
          )}
        </Button>
      </div>

      <div ref={bodyRef} role="tabpanel" className="scroll-mt-20 space-y-5">
        {active === "notes" ? (
          <DocsNotes pages={here} variant="chapter" />
        ) : (
          <>
            <DocsContent
              section={section}
              baseUrl={base}
              openaiBase={openaiBase}
              anthropicBase={anthropicBase}
              responsesBase={responsesBase}
            />
            {here.length > 0 && <DocsNotes pages={here} />}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
