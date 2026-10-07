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
  // The balance, as a chapter of its own. It used to sit at the bottom of the
  // OpenAI chapter, which put "how much do I have" underneath "how to send a
  // conversation" — two different questions, asked at different moments, by
  // different people. The first is read once while wiring something up; the
  // second is asked again every time something runs out.
  "credits",
  "sdks",
  "media",
  // The live catalogue: what this deployment serves, read from the provider
  // tables on every request. It is a chapter rather than a wall above the
  // document, because a wall is the first thing every reader scrolls past and
  // the last thing they come back to.
  "catalog",
  // The operator's own guide. The only id here that can be absent from the
  // outline: a deployment with nothing written has no such guide, and an
  // outline entry pointing at nothing is worse than a shorter outline.
  "parameters",
] as const;
export type UserDocId = (typeof USER_SECTION_IDS)[number];

/**
 * The chapters `DocsContent` renders.
 *
 * Excludes the two that are not a `section === "…"` branch of that component:
 * the catalogue is its own component, and the operator's chapter has no
 * built-in prose at all. Naming the difference is what stops a `catalog` that
 * reaches `DocsContent` from falling through to the last branch and rendering
 * the media page under a heading about models.
 */
export type ProseUserDocId = Exclude<UserDocId, "catalog" | "parameters">;

/**
 * The document is two guides, and a reader picks one.
 *
 * It used to be one list of ten tabs, and that is the shape the complaint came
 * from: the chapters that answer "how do I call this" sat shoulder to shoulder
 * with the chapter holding a 327-row voice table, so opening the document meant
 * choosing from a list that had nothing to do with each other.
 *
 * Splitting them is not a cosmetic grouping. The two halves are read for
 * different reasons and at different moments — the integration guide once, while
 * wiring something up; the parameters guide repeatedly, while choosing a value —
 * and only the second one is long enough to need paging.
 */
export type GuideId = "integration" | "parameters";

export const INTEGRATION_GUIDE = "integration" satisfies GuideId;

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
  // How to use the assistant, which is a page about the assistant rather than
  // about the gateway. It is separate from the user documentation on purpose:
  // what the assistant can change, and what it cannot, is a question only the
  // person standing behind the relay has.
  "assistant",
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
  "docs.nav.credits",
  "docs.nav.sdks",
  "docs.nav.media",
  "docs.nav.catalog",
  // The operator's guide is not a chapter among these any more — it is one of
  // the two guides the document is split into, and it carries its own paging.
  // The id stays in the list so `/docs/parameters` is a real route and the
  // generated index has an id to compare against.
  "docs.guide.parameters",
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

/**
 * The question each chapter answers, keyed by chapter id.
 *
 * A tab title says *which* chapter; it does not say *why this is the one you
 * want*, and a reader who lands in the wrong chapter cannot tell from the title
 * alone. So each chapter carries its own question, and a missing one is absent
 * from the map rather than rendered as an empty line.
 *
 * Written as literal keys rather than a template, so the strings are greppable
 * and the dictionary can be checked for keys nothing resolves.
 */
const CHAPTER_ANSWER_KEYS: Readonly<Record<string, string>> = {
  start: "docs.chapter.answers.start",
  endpoints: "docs.chapter.answers.endpoints",
  openai: "docs.chapter.answers.openai",
  anthropic: "docs.chapter.answers.anthropic",
  responses: "docs.chapter.answers.responses",
  models: "docs.chapter.answers.models",
  credits: "docs.chapter.answers.credits",
  sdks: "docs.chapter.answers.sdks",
  media: "docs.chapter.answers.media",
};

export function userChapterAnswers(t: TFn): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, key] of Object.entries(CHAPTER_ANSWER_KEYS)) out[id] = t(key);
  return out;
}

export function adminDocSections(t: TFn): DocSection[] {  return [
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
    { id: "assistant", label: t("admin.docs.nav.assistant") },
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
