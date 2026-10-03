"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Check, Copy } from "lucide-react";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";
import { DocsNotes } from "@/app/(user)/dashboard/docs/DocsNotes";
import type { DocSection } from "@/lib/docs/sections";
import { visibleDocPages, type DocPage } from "@/lib/docs/custom";
import type { ProseUserDocId, UserDocId } from "@/lib/docs/sections";

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
   * A chapter, not a wall above the tabs. It was on every route before, which
   * meant the first thing every reader saw was a table of every model — and the
   * first thing they had to scroll past to reach the chapter they came for. It
   * is the answer to "what can I actually call here", and that is a question
   * somebody asks deliberately, not something to put in front of them.
   */
  catalogue?: ReactNode;
  outlineLabel: string;
  copyPageLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}) {
  // The catalogue tab exists only where there is a catalogue. A public
  // deployment can switch its vendor list off — deliberately, for a private
  // relay — and a tab that opens onto an empty panel is worse than no tab.
  const tabs = useMemo(
    () => sections.filter((s) => s.id !== "catalog" || catalogue),
    [sections, catalogue],
  );

  // A deep link can name a chapter this deployment has nothing to show — the
  // catalogue on a deployment that does not publish it, or the operator's
  // chapter before they wrote anything in it. Land on the first real chapter
  // rather than an empty tab.
  const first = tabs[0]?.id ?? "start";
  const [active, setActive] = useState<string>(
    tabs.some((s) => s.id === initial) ? initial : first,
  );
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Back/forward moves between chapters; the tab has to follow.
  useEffect(() => {
    const sync = () => {
      const slug = window.location.pathname.split("/").filter(Boolean).pop() ?? "";
      setActive((current) => (tabs.some((s) => s.id === slug) ? slug : current));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [tabs]);

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

  // The operator's own chapter, in one place, in reading order.
  const here = active === "notes" ? visibleDocPages(pages) : [];

  return (
    <div className="space-y-5">
      {/*
        The outline, as tabs.

        The document opens on the tabs. Nothing is stacked above them: a wall of
        models in front of the chapter list meant the first thing every reader
        saw was a table they had not come for yet.
      */}
      <div
        role="tablist"
        aria-label={outlineLabel}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1"
      >
        {tabs.map((s) => {
          const on = s.id === active;
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
        {/*
          The catalogue is a chapter, so it is rendered only when its tab is
          open. Passing it as a node rather than reading it here keeps this
          component free of the provider tables, and keeps the catalogue out of
          the copy-this-page text for every other chapter.
        */}
        {active === "catalog" ? (
          catalogue ?? null
        ) : active === "notes" ? (
          <DocsNotes pages={here} />
        ) : (
          <DocsContent
            // `catalog` and `notes` are handled above, so whatever is left is
            // a chapter this component actually renders.
            section={active as ProseUserDocId}
            baseUrl={base}
            openaiBase={openaiBase}
            anthropicBase={anthropicBase}
            responsesBase={responsesBase}
          />
        )}
      </div>
    </div>
  );
}
