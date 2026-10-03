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
import { userDocSections, type DocSection, type TFn } from "./sections";

export type { DocPage };

/** The chapter the operator's pages live in. Its own id, so the outline can carry it. */
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
 * The reader's outline: the built-in chapters, plus the operator's own when
 * there is something in it.
 *
 * `notes` is stripped from the built-in list first. It is in `USER_SECTION_IDS`
 * so that `/docs/notes` is a real route and the generated index has an id to
 * compare against — but the outline only offers it when there is something in
 * it, and appending it without stripping first would offer it twice.
 */
export function userDocOutline(t: TFn, pages: readonly DocPage[] | undefined): DocSection[] {
  const built = userDocSections(t).filter((s) => s.id !== NOTES_SECTION);
  if (!hasVisibleDocPages(pages)) return built;
  return [...built, { id: NOTES_SECTION, label: t("docs.nav.notes") }];
}
