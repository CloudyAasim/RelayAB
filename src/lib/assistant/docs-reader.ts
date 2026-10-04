/**
 * src/lib/assistant/docs-reader.ts
 *
 * Read the documentation this deployment actually shows.
 *
 * The built-in pages are React components whose prose is i18n text, grouped by
 * a `section === "…"` branch. Neither the components nor `docs/` is shipped
 * inside the runtime image, so the grouping is pre-extracted into
 * `docs-index.generated.ts` and the text is resolved from the dictionary at
 * call time. Which is also why the answer comes out in the reader's own
 * language: the same strings, resolved against their locale.
 *
 * The operator's own pages are the exception: written at runtime from a form,
 * so they cannot be in a generated file. They arrive as `pages`, read once by
 * the caller, which is why nothing here is async and nothing here caches.
 */
import { translate, type Locale } from "../i18n/dict";
import type { DocPage } from "../db/settings";
import { visibleDocPages, PARAMETERS_SECTION } from "../docs/custom";
import { WEB_DOC_SECTIONS } from "./docs-index.generated";

/**
 * Past this a page is cut off with a marker rather than sent whole.
 *
 * The turn loop truncates a tool result at 24 000 characters, and where it
 * lands is not something a reader gets to choose. Trimming here means the cut
 * is at a place this code picked, and the model is told which page it was
 * reading.
 */
const MAX_PAGE_CHARS = 20_000;

/**
 * The same number, named for what it means to somebody deciding how to write a
 * page rather than for where it is applied.
 *
 * Exported so the approval diff can say "this page is longer than the assistant
 * can read" using the reader's own constant. Two copies of 20 000 would drift,
 * and the failure is silent: a page that saves, renders whole, and gets cut in
 * half on the way to the model.
 */
export const ASSISTANT_PAGE_READ_LIMIT = MAX_PAGE_CHARS;

export interface DocIndexEntry {
  /** `user:openai`, `admin:providers` — the id to pass back. */
  topic: string;
  surface: "user" | "admin";
  summary: string;
  /** How many lines of prose the page carries, for choosing between them. */
  lines: number;
}

export interface DocReader {
  index: DocIndexEntry[];
  read: (topic: string, locale: Locale, visible: "user" | "admin") => DocRead;
}

export type DocRead =
  | { ok: true; topic: string; title: string; text: string; truncated: boolean }
  | { ok: false; topic: string; reason: string; available?: DocIndexEntry[] };

/**
 * Build a reader over this deployment's documentation.
 *
 * The operator's pages go in rather than being read here: one settings read
 * per turn, in the caller, and no module-level cache to get wrong when two
 * conversations are in flight.
 */
export function createDocReader(pages: readonly DocPage[] | undefined): DocReader {
  // One chapter, everything in it — the same place a reader looks.
  const operator = visibleDocPages(pages);

  const index: DocIndexEntry[] = [
    ...WEB_DOC_SECTIONS.filter(
      // The generated index always carries the operator's chapter, because the
      // drift guard compares it against the outline and the outline owns the
      // id. Whether a reader is *offered* it is a separate question, and the
      // answer is no when the operator has written nothing.
      (s) => !(s.surface === "user" && s.id === PARAMETERS_SECTION) || operator.length > 0,
    ).map((s) => ({
      topic: `${s.surface}:${s.id}`,
      surface: s.surface,
      summary: s.summary,
      lines: s.keys.length,
    })),
    ...operator.map((p) => ({
      topic: `user:${PARAMETERS_SECTION}#${p.id}`,
      surface: "user" as const,
      summary: p.title,
      /**
       * The real length, not 1.
       *
       * It was 1 for every operator page, which is a claim the model had no way
       * to check and no reason to distrust — so it read a 327-row voice table
       * the same way it read a one-paragraph rate limit, and either swallowed
       * the lot or skipped it. A reference page is *chosen* by size: someone
       * asking for Korean voices should not have to read the Portuguese ones to
       * find out.
       */
      lines: p.body.split("\n").length,
    })),
  ];

  const ofSurface = (surface: "user" | "admin") => index.filter((e) => e.surface === surface);

  /** The whole parameters guide, as one labelled block. */
  const notesBlock = (): string =>
    operator.map((p) => `## ${p.title}\n${p.body}`).join("\n\n");

  function read(topic: string, locale: Locale, visibleSurface: "user" | "admin"): DocRead {
    const want = topic.trim().toLowerCase();
    const [rawSurface, rest] = want.includes(":") ? [want.slice(0, want.indexOf(":")), want.slice(want.indexOf(":") + 1)] : [visibleSurface, want];
    const surface = rawSurface === "admin" ? "admin" : "user";

    // `user:parameters#rate-limits` — one page of the parameters guide.
    if (rest.startsWith(`${PARAMETERS_SECTION}#`)) {
      const slug = rest.slice(PARAMETERS_SECTION.length + 1);
      const page = operator.find((p) => p.id === slug);
      if (!page) {
        return {
          ok: false,
          topic,
          reason: `参数指南里没有 id 为「${slug}」的页面。可用的是：${operator.map((p) => p.id).join(", ") || "（这一章还是空的）"}`,
        };
      }
      const body =
        page.body.length > MAX_PAGE_CHARS
          ? `${page.body.slice(0, MAX_PAGE_CHARS)}\n…（这一页很长，已截断）`
          : page.body;
      return {
        ok: true,
        topic: `user:${PARAMETERS_SECTION}#${page.id}`,
        title: page.title,
        text: body,
        truncated: body.length < page.body.length,
      };
    }

    const section = WEB_DOC_SECTIONS.find((s) => s.surface === surface && s.id === rest);
    if (!section) {
      const other = WEB_DOC_SECTIONS.find((s) => s.surface !== surface && s.id === rest);
      return {
        ok: false,
        topic,
        reason: other
          ? `这一页只在 ${other.surface === "admin" ? "管理员文档" : "用户文档"}里，普通用户看不到。`
          : `没有这一页。可用的是：${ofSurface(surface)
              .map((e) => e.topic)
              .join(", ")}`,
        available: ofSurface(surface),
      };
    }

    // The parameters guide is a guide like any other: it is read by its own
    // topic, not folded into a built-in one.
    if (section.surface === "user" && section.id === PARAMETERS_SECTION) {
      const text = notesBlock();
      return {
        ok: true,
        topic: `user:${PARAMETERS_SECTION}`,
        title: section.summary,
        text,
        truncated: text.length > MAX_PAGE_CHARS ? false : text.length < MAX_PAGE_CHARS,
      };
    }

    if (section.note) {
      return { ok: true, topic: `${section.surface}:${section.id}`, title: section.summary, text: section.note, truncated: false };
    }

    if (section.keys.length === 0) {
      return {
        ok: false,
        topic: `${section.surface}:${section.id}`,
        reason: "这一页没有可读的文字内容。",
        available: ofSurface(section.surface),
      };
    }

    // A key that resolves to itself is the fallback identity, and seeing it in
    // the output is how a broken dictionary entry becomes visible instead of
    // reading as a page that says nothing.
    const lines = section.keys.map((key) => {
      const value = translate(locale, key);
      return value === key ? `[missing: ${key}]` : value;
    });

    let text = lines.join("\n");
    let truncated = false;
    if (text.length > MAX_PAGE_CHARS) {
      text = `${text.slice(0, MAX_PAGE_CHARS)}\n…（这一页很长，已截断；需要后面的部分请按 topic 再问一次）`;
      truncated = true;
    }

    return { ok: true, topic: `${section.surface}:${section.id}`, title: section.summary, text, truncated };
  }

  return { index, read };
}
