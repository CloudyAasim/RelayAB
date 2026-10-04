/**
 * src/lib/docs/custom.ts
 *
 * The operator's own documentation: one chapter of their own.
 *
 * Small enough to be a pure module with no I/O, which is deliberate: the rules
 * about which pages a reader may see, in what order, and what a page may be
 * called are the part worth testing, and they are the part that would otherwise
 * be spread across a component, a schema and a query.
 *
 * The one decision here, and it is a decision the previous version got wrong:
 * the operator's pages all live in **one** chapter, together, at the end. A
 * version of this let each page name a chapter to be filed under, so the pages
 * were scattered through the document. That reads worse than an appendix does
 * — the reader looking for the rate limit has to know which chapter somebody
 * filed it under, and the operator has to decide that every time. One chapter,
 * everything in it, one place to look.
 */
import type { DocPage } from "@/lib/db/settings";
import {
  userDocSections,
  INTEGRATION_GUIDE,
  type DocSection,
  type GuideId,
  type TFn,
} from "./sections";

export type { DocPage };

/**
 * The guide the operator's own pages live in. Its own id, so the outline can
 * carry it and a deep link can name it.
 *
 * Renamed from `notes` to `parameters` because that is what the chapter is for.
 * "Notes" is what a deployment accumulates; "parameters" is what a reader comes
 * for — the voice list, the image sizes, the fields each endpoint takes. The
 * rename is deliberate on both sides: the id in the url and the topic the
 * assistant's `read_docs` tool takes both change, and a stale `user:notes#…`
 * in a prompt or a bookmark should read as not-found rather than silently
 * resolving to something else.
 */
export const PARAMETERS_SECTION = "parameters";

/** Kept so a bookmark from before the rename still lands somewhere real. */
export const NOTES_SECTION = PARAMETERS_SECTION;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a page is unusable, in the words the editor can act on. */
export function validatePage(page: Partial<DocPage>): string | null {
  if (!page.id || !page.id.trim()) return "page needs an id";
  if (!ID_RE.test(page.id.trim())) return "id may only contain lowercase letters, digits and dashes";
  if (page.id.trim().length > 60) return "id is too long";
  if (!page.title || !page.title.trim()) return "page needs a title";
  if (page.title.trim().length > 120) return "title is too long";
  if (page.body !== undefined && page.body.length > 60_000) return "body is too long";
  return null;
}

/**
 * Pages in reading order: explicit order first, then title.
 *
 * Title rather than insertion order, because an operator who does not set an
 * order still expects the pages they wrote in a sensible sequence rather than
 * in whatever order the rows came back.
 */
export function sortDocPages(pages: readonly DocPage[]): DocPage[] {
  return [...pages].sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title);
  });
}

/** The pages a reader may see, in reading order. */
export function visibleDocPages(pages: readonly DocPage[] | undefined): DocPage[] {
  return sortDocPages((pages ?? []).filter((p) => !p.hidden));
}

/**
 * Does this deployment have a chapter of its own to show?
 *
 * A deployment with nothing written has no such chapter, so the document reads
 * exactly as it did before custom docs existed. A permanent entry saying
 * "there is nothing here" is what makes a custom section look bolted on.
 */
export function hasVisibleDocPages(pages: readonly DocPage[] | undefined): boolean {
  return visibleDocPages(pages).length > 0;
}

/**
 * One of the two guides the reader picks between.
 *
 * Only one of `chapters` and `pages` is ever populated, which is the point: the
 * integration guide is a handful of built-in chapters, and the parameters guide
 * is a list of operator pages long enough to need its own paging. A guide with
 * both would be the single long list this split exists to end.
 */
export interface DocGuide {
  id: GuideId;
  label: string;
  /** Built-in chapters. Empty for the parameters guide. */
  chapters: DocSection[];
  /** Operator pages, in reading order. Empty for the integration guide. */
  pages: DocPage[];
}

/**
 * The document, as two guides.
 *
 * The parameters guide is absent when the operator has written nothing, so a
 * deployment with nothing written reads exactly as it did before custom docs
 * existed — one guide, no switch, nothing saying "there is nothing here".
 */
export function userDocGuides(t: TFn, pages: readonly DocPage[] | undefined): DocGuide[] {
  const guides: DocGuide[] = [
    {
      id: INTEGRATION_GUIDE,
      label: t("docs.guide.integration"),
      chapters: userDocSections(t).filter((s) => s.id !== PARAMETERS_SECTION),
      pages: [],
    },
  ];
  const visible = visibleDocPages(pages);
  if (visible.length > 0) {
    guides.push({
      id: PARAMETERS_SECTION,
      label: t("docs.guide.parameters"),
      chapters: [],
      pages: visible,
    });
  }
  return guides;
}

/**
 * The integration guide's chapters on their own.
 *
 * Kept because the generated index is compared against it: the index carries an
 * entry for the parameters guide — so `/docs/parameters` has an id to resolve —
 * and that entry has to be subtracted before the comparison or the guard reports
 * a chapter that exists in both places as drift.
 */
export function userDocOutline(t: TFn, pages: readonly DocPage[] | undefined): DocSection[] {
  const built = userDocSections(t).filter((s) => s.id !== PARAMETERS_SECTION);
  if (!hasVisibleDocPages(pages)) return built;
  return [...built, { id: PARAMETERS_SECTION, label: t("docs.guide.parameters") }];
}
