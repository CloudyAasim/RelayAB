/**
 * src/lib/docs/custom.ts
 *
 * The operator's own documentation, and where it goes in the reader's document.
 *
 * Small enough to be a pure module with no I/O, which is deliberate: the rules
 * about which page belongs under which chapter, in what order, and what a page
 * may be called are the part worth testing, and they are the part that would
 * otherwise be spread across a component, a schema and a query.
 *
 * The one idea here: an operator's page is *filed under a chapter*, not appended
 * after one. A rate limit belongs on the page where somebody goes looking for
 * the rate limit. A page parked in an appendix at the end of the outline is
 * documentation nobody finds, which is the same as not writing it.
 */
import type { DocPage } from "@/lib/db/settings";
import { isUserDocId, userDocSections, type DocSection, type TFn } from "./sections";

export type { DocPage };

/** The fallback chapter, for a page that was not filed under anything. */
export const NOTES_SECTION = "notes";

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why a page is unusable, in the words the editor can act on. */
export function validatePage(page: Partial<DocPage>): string | null {
  if (!page.id || !page.id.trim()) return "page needs an id";
  if (!ID_RE.test(page.id.trim())) return "id may only contain lowercase letters, digits and dashes";
  if (page.id.trim().length > 60) return "id is too long";
  if (!page.title || !page.title.trim()) return "page needs a title";
  if (page.title.trim().length > 120) return "title is too long";
  if (page.body !== undefined && page.body.length > 60_000) return "body is too long";
  if (page.section !== undefined && page.section && !isUserDocId(page.section)) {
    return "that is not a chapter of these docs";
  }
  return null;
}

/**
 * Which chapter a page belongs to, whatever was stored.
 *
 * Anything that is not a real chapter of these docs lands in `notes`, so a page
 * saved against a chapter that has since been renamed reads as an appendix
 * entry instead of vanishing from the outline.
 */
export function pageSection(page: DocPage): string {
  return page.section && isUserDocId(page.section) ? page.section : NOTES_SECTION;
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
 * The visible pages, bucketed by the chapter they were filed under.
 *
 * Only chapters that actually received a page are in the map. That absence is
 * what the outline consults before it draws anything: a chapter entry with no
 * pages under it is the thing that makes custom documentation look bolted on.
 */
export function pagesBySection(pages: readonly DocPage[] | undefined): Map<string, DocPage[]> {
  const grouped = new Map<string, DocPage[]>();
  for (const page of visibleDocPages(pages)) {
    const key = pageSection(page);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(page);
    else grouped.set(key, [page]);
  }
  return grouped;
}

/** The pages one chapter shows, or none. */
export function pagesForSection(
  pages: readonly DocPage[] | undefined,
  section: string,
): DocPage[] {
  return pagesBySection(pages).get(section) ?? [];
}

/** The chapters that have at least one page to show. */
export function sectionsWithPages(pages: readonly DocPage[] | undefined): string[] {
  return [...pagesBySection(pages).keys()];
}

/**
 * Does this deployment have anything to say beyond the built-in pages?
 *
 * A deployment with nothing written has no extra outline entries and no extra
 * chapter, so the document reads exactly as it did before custom docs existed.
 */
export function hasVisibleDocPages(pages: readonly DocPage[] | undefined): boolean {
  return visibleDocPages(pages).length > 0;
}

/**
 * The reader's outline: the built-in chapters, each carrying the operator's
 * pages filed under it.
 *
 * A page filed under a chapter becomes an indented sub-entry under that
 * chapter's own link. Unfiled pages fall into `notes`, and that chapter appears
 * only when something landed in it — a permanent entry saying "there is
 * nothing here" is what makes a custom section look bolted on.
 */
export function userDocOutline(
  t: TFn,
  pages: readonly DocPage[] | undefined,
): DocSection[] {
  const grouped = pagesBySection(pages);
  const out: DocSection[] = [];

  for (const section of userDocSections(t)) {
    const children = grouped.get(section.id) ?? [];
    const empty = section.id === NOTES_SECTION && children.length === 0;
    if (empty) continue;
    out.push(children.length ? { ...section, children: children.map(toLink) } : section);
  }

  return out;
}

/** An outline sub-entry. The href is built by the shell, which knows the base. */
function toLink(page: DocPage): { id: string; label: string } {
  return { id: page.id, label: page.title };
}
