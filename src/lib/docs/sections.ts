/**
 * src/lib/docs/sections.ts
 *
 * The two documentation outlines. Each doc surface (public / user, admin) is
 * split into one page per section so long, single-page walls of cards become a
 * navigable set of pages with prev/next.
 *
 * Labels are resolved through `t()` at call time — the keys are written as
 * literals so `tests/unit/i18n-usage.test.ts` still sees every one of them.
 */

export interface DocSection {
  id: string;
  label: string;
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
] as const;
export type UserDocId = (typeof USER_SECTION_IDS)[number];

const ADMIN_SECTION_IDS = [
  "overview",
  "providers",
  "faces",
  "routes",
  "mapping",
  "quota",
  "media",
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

export function userDocSections(t: TFn): DocSection[] {
  return [
    { id: "start", label: t("docs.nav.start") },
    { id: "endpoints", label: t("docs.nav.endpoints") },
    { id: "openai", label: t("docs.nav.openai") },
    { id: "anthropic", label: t("docs.nav.anthropic") },
    { id: "responses", label: t("docs.nav.responses") },
    { id: "models", label: t("docs.nav.models") },
    { id: "sdks", label: t("docs.nav.sdks") },
    { id: "media", label: t("docs.nav.media") },
  ];
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

