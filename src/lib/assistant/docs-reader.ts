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
import { pageSection, pagesBySection, NOTES_SECTION } from "../docs/custom";
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
  const grouped = pagesBySection(pages);
  // Every published page, flattened, so `read` can find one by its slug without
  // caring which chapter it was filed under.
  const operator = [...grouped.values()].flat();
  const operatorById = new Map(operator.map((p) => [p.id, p]));

  const index: DocIndexEntry[] = [
    ...WEB_DOC_SECTIONS.filter(
      // The generated index always carries the operator's chapter, because the
      // drift guard compares it against the outline and the outline owns the
      // id. Whether a reader is *offered* it is a separate question, and the
      // answer is no when nothing was filed under it.
      (s) => !(s.surface === "user" && s.id === NOTES_SECTION) || grouped.has(NOTES_SECTION),
    ).map((s) => ({
      topic: `${s.surface}:${s.id}`,
      surface: s.surface,
      summary: s.summary,
      lines: s.keys.length,
    })),
    // One entry per published page, under the chapter it renders in — the same
    // place a reader would look for it, and where the model should look too.
    ...operator.map((p) => ({
      topic: `user:${pageSection(p)}#${p.id}`,
      surface: "user" as const,
      summary: p.title,
      lines: 1,
    })),
  ];

  const ofSurface = (surface: "user" | "admin") => index.filter((e) => e.surface === surface);

  /** The operator's text for one chapter, as a labelled block. */
  const notesBlock = (section: string): string =>
    (grouped.get(section) ?? [])
      .map((p) => `## ${p.title}（站长补充）\n${p.body}`)
      .join("\n\n");

  function read(topic: string, locale: Locale, visibleSurface: "user" | "admin"): DocRead {
    const want = topic.trim().toLowerCase();
    const [rawSurface, rest] = want.includes(":") ? [want.slice(0, want.indexOf(":")), want.slice(want.indexOf(":") + 1)] : [visibleSurface, want];
    const surface = rawSurface === "admin" ? "admin" : "user";

    // `user:endpoints#rate-limits` — one page of the operator's own prose,
    // whichever chapter it was filed under.
    if (surface === "user" && rest.includes("#")) {
      const [section, slug] = rest.split("#");
      const page = operatorById.get(slug);
      if (!page) {
        return {
          ok: false,
          topic,
          reason: `没有 id 为「${slug}」的自定义页面。可用的是：${operator.map((p) => p.id).join(", ") || "（还没有自定义页面）"}`,
        };
      }
      if (section && pageSection(page) !== section) {
        return {
          ok: false,
          topic,
          reason: `「${page.title}」不在 ${section} 这一章，而在 ${pageSection(page)}。正确写法是 user:${pageSection(page)}#${page.id}。`,
        };
      }
      const body =
        page.body.length > MAX_PAGE_CHARS
          ? `${page.body.slice(0, MAX_PAGE_CHARS)}\n…（这一页很长，已截断）`
          : page.body;
      return {
        ok: true,
        topic: `user:${pageSection(page)}#${page.id}`,
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

    // The operator's notes filed under this chapter are part of this chapter as
    // far as a reader is concerned, so they are part of what the model reads.
    const notes =
      section.surface === "user" && grouped.has(section.id) ? `\n\n---\n\n${notesBlock(section.id)}` : "";

    if (section.note) {
      return { ok: true, topic: `${section.surface}:${section.id}`, title: section.summary, text: section.note + notes, truncated: false };
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
    } else if (notes) {
      text += notes;
    }

    return { ok: true, topic: `${section.surface}:${section.id}`, title: section.summary, text, truncated };
  }

  return { index, read };
}
