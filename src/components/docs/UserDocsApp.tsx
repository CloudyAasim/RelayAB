"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Check, Copy } from "lucide-react";
import { DocsContent } from "@/app/(user)/dashboard/docs/DocsContent";
import { DocsParameters } from "@/app/(user)/dashboard/docs/DocsParameters";
import { INTEGRATION_GUIDE, type DocSection, type GuideId, type ProseUserDocId } from "@/lib/docs/sections";
import { PARAMETERS_SECTION } from "@/lib/docs/custom";
import type { DocGuide } from "@/lib/docs/custom";

/**
 * The reader-facing documentation: two guides, and a switch between them.
 *
 * **Why two and not one list.** It used to be ten tabs in a row, with the
 * chapter that explains how to call this sitting shoulder to shoulder with the
 * chapter holding a 327-row voice table. The two are read for different reasons
 * at different moments — the first once, while wiring something up; the second
 * repeatedly, while choosing a value — and a reader arriving for either had to
 * pick from a list where almost nothing was relevant. A switch at the top says
 * which question they are asking, and each side can then be shaped for it: the
 * integration guide is a short set of chapters, the parameters guide pages
 * because it is long.
 *
 * **Why still one page.** Every chapter used to be its own route, so moving
 * between them was a navigation: a server round trip, a loading boundary, and
 * whatever the router had already fetched. The whole document is loaded once
 * and switching is local state, so there is no request to be stale, nothing to
 * prefetch and nothing to wait for.
 *
 * The url tracks both levels, with `replaceState`, so a link to a chapter — or
 * to one page of the parameters guide — is still a link. It just no longer
 * causes a navigation.
 */
export function UserDocsApp({
  guides,
  initial,
  initialPage,
  basePath,
  base,
  openaiBase,
  anthropicBase,
  catalogue,
  outlineLabel,
  copyPageLabel,
  copiedLabel,
  copyFailedLabel,
}: {
  guides: DocGuide[];
  /** From the route, so a deep link opens the right guide and chapter. */
  initial: string;
  /** Which page of the parameters guide a deep link names. */
  initialPage: string | null;
  basePath: string;
  base: string;
  openaiBase: string;
  anthropicBase: string;
  /**
   * The live model catalogue, when this deployment shows one.
   *
   * A chapter of the integration guide, not a wall above the switch. It was on
   * every route before, which meant the first thing every reader saw was a table
   * of every model — and the first thing they had to scroll past to reach the
   * chapter they came for. It is the answer to "what can I actually call here",
   * and that is a question somebody asks deliberately, not something to put in
   * front of them.
   */
  catalogue?: ReactNode;
  outlineLabel: string;
  copyPageLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
}) {
  const integration = guides.find((g) => g.id === INTEGRATION_GUIDE) ?? guides[0];

  // The catalogue tab exists only where there is a catalogue. A public
  // deployment can switch its vendor list off — deliberately, for a private
  // relay — and a tab that opens onto an empty panel is worse than no tab.
  const chapters = useMemo(
    () => integration.chapters.filter((s) => s.id !== "catalog" || catalogue),
    [integration.chapters, catalogue],
  );

  /**
   * Which guide is open, from the url when it says so.
   *
   * A deep link can name a guide this deployment has nothing to show — the
   * parameters guide before anything is written in it. Land on the integration
   * guide rather than on an empty switch.
   */
  const [guide, setGuide] = useState<GuideId>(
    guides.some((g) => g.id === initial) ? (initial as GuideId) : INTEGRATION_GUIDE,
  );
  // A deep link can also name a chapter that is not a real one (the catalogue
  // on a deployment that does not publish it). First real chapter instead.
  const [chapter, setChapter] = useState<string>(
    chapters.some((s) => s.id === initial) ? initial : (chapters[0]?.id ?? "start"),
  );
  const parameters = guides.find((g) => g.id === PARAMETERS_SECTION);
  // A deep link can name a page id that was deleted or renamed. The reader
  // resolves it; an unknown one lands on the first page rather than on nothing.
  const [pageId, setPageId] = useState<string | null>(initialPage);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Back/forward moves between chapters and pages; the tabs have to follow.
  useEffect(() => {
    const sync = () => {
      const parts = window.location.pathname.split("/").filter(Boolean);
      const slug = parts.pop() ?? "";
      const wanted = new URLSearchParams(window.location.search).get("p");
      setGuide((current) =>
        guides.some((g) => g.id === slug) ? (slug as GuideId) : current,
      );
      setChapter((current) => (chapters.some((s) => s.id === slug) ? slug : current));
      setPageId((current) => (wanted ? wanted : current));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [guides, chapters]);

  function toIntegration(id: string) {
    setGuide(INTEGRATION_GUIDE);
    setChapter(id);
    // Shareable, but not a navigation. `pushState` would put every chapter in
    // the history and make the back button walk the document.
    window.history.replaceState(null, "", `${basePath}/${id}`);
    bodyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function toParameters(id: string) {
    setGuide(PARAMETERS_SECTION);
    setPageId(id);
    // The page travels in the query because the route is one segment deep;
    // `?p=` is what makes a particular page a link rather than a position.
    window.history.replaceState(null, "", `${basePath}/${PARAMETERS_SECTION}?p=${encodeURIComponent(id)}`);
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

  const onParameters = guide === PARAMETERS_SECTION && parameters;
  const pages = onParameters ? parameters.pages : [];
  const activePage = pages.find((p) => p.id === pageId) ?? pages[0] ?? null;

  return (
    <div className="space-y-5">
      {/*
        The switch, then the contents of whichever side is open.

        Not a tablist over both: the two sides are not peers, and rendering the
        chapters' tabs next to the parameters guide's page list would put the
        long list back in the same row as the short chapters — which is the
        arrangement this split exists to end.
      */}
      {guides.length > 1 && (
        <div role="tablist" aria-label={outlineLabel} className="flex gap-2">
          {guides.map((g) => {
            const on = g.id === guide;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => (g.id === INTEGRATION_GUIDE ? toIntegration(chapter) : toParameters(g.pages[0]?.id ?? ""))}
                className={cn(
                  "flex-1 rounded-lg border-2 px-4 py-2.5 text-left transition-colors",
                  on
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-muted-foreground/40",
                )}
              >
                <span className={cn("block text-sm font-medium", on ? "text-primary" : "text-foreground")}>
                  {g.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {g.id === INTEGRATION_GUIDE
                    ? g.chapters.length
                    : `${g.pages.length} ${g.pages.length === 1 ? "page" : "pages"}`}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/*
        The integration guide's own chapters, only while it is open. The
        parameters guide brings its page list with it, so it is not repeated
        here.
      */}
      {!onParameters && (
        <div role="tablist" aria-label={outlineLabel} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {chapters.map((s) => {
            const on = s.id === chapter;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => toIntegration(s.id)}
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
      )}

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
        {onParameters ? (
          <DocsParameters
            pages={pages}
            activeId={activePage?.id ?? null}
            onSelect={toParameters}
          />
        ) : chapter === "catalog" ? (
          catalogue ?? null
        ) : (
          <DocsContent
            section={chapter as ProseUserDocId}
            baseUrl={base}
            openaiBase={openaiBase}
            anthropicBase={anthropicBase}
          />
        )}
      </div>
    </div>
  );
}

/** The chapter list a caller still passes around, for the outline it renders. */
export type { DocSection };
