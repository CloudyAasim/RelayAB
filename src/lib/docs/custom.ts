/**
 * src/lib/docs/custom.ts
 *
 * The operator's own documentation, as pages.
 *
 * Small enough to be a pure module with no I/O, which is deliberate: the rules
 * about which pages are visible, in what order, and what a page may be called
 * are the part worth testing, and they are the part that would otherwise be
 * spread across a component, a schema and a query.
 */
import type { DocPage } from "@/lib/db/settings";

export type { DocPage };

/** The chapter slug. Its own id, so the outline can carry it like any other. */
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

/** The pages a reader may see. */
export function visibleDocPages(pages: readonly DocPage[] | undefined): DocPage[] {
  return sortDocPages((pages ?? []).filter((p) => !p.hidden));
}

/**
 * Does this deployment have a chapter to show?
 *
 * What the outline consults. A permanent entry pointing at an empty chapter is
 * the thing that makes a custom section look bolted on, so its absence has to
 * be visible before anything renders.
 */
export function hasVisibleDocPages(pages: readonly DocPage[] | undefined): boolean {
  return visibleDocPages(pages).length > 0;
}
