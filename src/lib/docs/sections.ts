/**
 * src/lib/docs/sections.ts
 *
 * The two documentation outlines. Each doc surface (public / user, admin) is
 * split into one page per section so long, single-page walls of cards become a
 * navigable set of pages with prev/next.
 *
 * This module knows *which chapters exist* and what they are called. It knows
 * nothing about what the operator has written — that is `lib/docs/custom.ts`,
 * which depends on this file and not the other way round, so there is no cycle
 * between the two.
 *
 * Labels are resolved through `t()` at call time — the keys are written as
 * literals so `tests/unit/i18n-usage.test.ts` still sees every one of them.
 */

export interface DocChildLink {
  /** The page id, which is also its anchor on the chapter. */
  id: string;
  label: string;
}

export interface DocSection {
  id: string;
  label: string;
  /**
   * The operator's own pages filed under this chapter.
   *
   * Indented under the chapter in the outline rather than given a chapter of
   * their own, because a note about rate limits belongs where somebody looks
   * for the rate limit, not in an appendix they have to know exists.
   */
  children?: DocChildLink[];
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

const USER_SECTION_IDS = [
  "start",
  "endpoints",
  "openai",
  "anthropic",
  "responses",
  "models",
  "sdks",
  "media",
  // The fallback chapter, for a page the operator did not file under anything.
  // The only id here that can be absent from the outline: a deployment with
  // nothing written has no such chapter, and an outline entry pointing at
  // nothing is worse than a shorter outline.
  "notes",
] as const;
export type UserDocId = (typeof USER_SECTION_IDS)[number];

/** Exported for tests: the exact slugs the admin docs outline accepts. */
export const ADMIN_SECTION_IDS = [
  "overview",
  "providers",
  "faces",
  "routes",
  "mapping",
  "quota",
  "media",
  // The judge's own source, rendered from scripts/spec-check.ts. It lives on its
  // own page because it is ~1,400 lines — a reference to read or copy, not part
  // of the protocol prose.
  "spec-check",
  "usage",
  "trouble",
  "ops",
] as const;
export type AdminDocId = (typeof ADMIN_SECTION_IDS)[number];

export const USER_DOC_DEFAULT: UserDocId = "start";
export const ADMIN_DOC_DEFAULT: AdminDocId = "overview";

export function isUserDocId(value: string): value is UserDocId {
  return (USER_SECTION_IDS as readonly string[]).includes(value);
}

export function isAdminDocId(value: string): value is AdminDocId {
  return (ADMIN_SECTION_IDS as readonly string[]).includes(value);
}

/** Every user-doc chapter id, in outline order. */
export const USER_SECTION_ID_LIST: readonly string[] = USER_SECTION_IDS;

/** The i18n key each built-in chapter's label comes from, in outline order. */
const USER_LABEL_KEYS = [
  "docs.nav.start",
  "docs.nav.endpoints",
  "docs.nav.openai",
  "docs.nav.anthropic",
  "docs.nav.responses",
  "docs.nav.models",
  "docs.nav.sdks",
  "docs.nav.media",
  "docs.nav.notes",
] as const;

/**
 * The built-in chapters, in outline order, without any operator pages attached.
 *
 * `custom.ts` layers the operator's pages onto this; nothing else needs to know
 * the two halves exist.
 */
export function userDocSections(t: TFn): Omit<DocSection, "children">[] {
  return USER_LABEL_KEYS.map((key, i) => ({ id: USER_SECTION_IDS[i], label: t(key) }));
}

export function adminDocSections(t: TFn): DocSection[] {
  return [
    { id: "overview", label: t("admin.docs.nav.overview") },
    { id: "providers", label: t("admin.docs.nav.providers") },
    { id: "faces", label: t("admin.docs.nav.faces") },
    { id: "routes", label: t("admin.docs.nav.routes") },
    { id: "mapping", label: t("admin.docs.nav.mapping") },
    { id: "quota", label: t("admin.docs.nav.quota") },
    { id: "media", label: t("admin.docs.nav.media") },
    { id: "spec-check", label: t("admin.docs.nav.specCheck") },
    { id: "usage", label: t("admin.docs.nav.usage") },
    { id: "trouble", label: t("admin.docs.nav.trouble") },
    { id: "ops", label: t("admin.docs.nav.ops") },
  ];
}

/**
 * True when `pathname` is a docs index or a *known* section page.
 *
 * The authenticated docs surfaces sit behind a `loading.tsx`, so the response
 * starts streaming before the page can `redirect()`/`notFound()` — both get
 * swallowed into a 200. Middleware runs first, so it is the only place that can
 * turn an unknown slug into a real redirect.
 */
export function isKnownDocsPath(pathname: string): boolean {
  const match = /^\/(?:admin\/docs|dashboard\/docs|docs)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return true;
  const slug = match[1];
  return isUserDocId(slug) || isAdminDocId(slug);
}
