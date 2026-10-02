/**
 * src/lib/assistant/docs-reader.ts
 *
 * Read the documentation this deployment actually shows.
 *
 * The pages are React components whose prose is i18n text, grouped by a
 * `section === "…"` branch. Neither the components nor `docs/` is shipped
 * inside the runtime image, so the grouping is pre-extracted into
 * `docs-index.generated.ts` and the text is resolved from the dictionary at
 * call time. Which is also why the answer comes out in the reader's own
 * language: the same strings, resolved against their locale.
 *
 * What this deliberately is not: a second copy of the documentation. The index
 * is a list of keys, and a key that is not rendered is not invented — a section
 * the generator could not attribute says so rather than returning silence the
 * model would read as "the page is empty".
 */
import { translate, type Locale } from "../i18n/dict";
import { WEB_DOC_SECTIONS, type WebDocSection } from "./docs-index.generated";

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

/** Every documentation page, for the model to choose from. */
export function docIndex(surface?: "user" | "admin"): DocIndexEntry[] {
  return WEB_DOC_SECTIONS.filter((s) => !surface || s.surface === surface).map((s) => ({
    topic: `${s.surface}:${s.id}`,
    surface: s.surface,
    summary: s.summary,
    lines: s.keys.length,
  }));
}

function find(surface: "user" | "admin", id: string): WebDocSection | undefined {
  return WEB_DOC_SECTIONS.find((s) => s.surface === surface && s.id === id);
}

export type DocRead =
  | { ok: true; topic: string; title: string; text: string; truncated: boolean }
  | { ok: false; topic: string; reason: string; available?: DocIndexEntry[] };

/**
 * One page, in the reader's language.
 *
 * A missing topic lists what there is, because "no such page" with no next step
 * is the one answer that makes a model give up rather than try the next name.
 */
export function readDoc(
  topic: string,
  locale: Locale,
  visible: "user" | "admin",
): DocRead {
  const want = topic.trim().toLowerCase();
  const [rawSurface, rawId] = want.includes(":") ? want.split(":") : [visible, want];
  const surface = rawSurface === "admin" ? "admin" : "user";
  const id = rawId;

  if (!id) {
    return {
      ok: false,
      topic,
      reason: "没有指定 topic。",
      available: docIndex(surface),
    };
  }

  const section = find(surface, id);
  if (!section) {
    const wrongSurface = find(rawSurface === "admin" ? "user" : "admin", id);
    return {
      ok: false,
      topic,
      reason: wrongSurface
        ? `admin: 文档里有这一页，但普通用户看不到。管理员自己用没问题；给普通用户看时请改用 fetch_page 或直接摘录要点。`
        : `没有这一页。可用的是：${docIndex(surface)
            .map((e) => e.topic)
            .join(", ")}`,
      available: docIndex(surface),
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
      available: docIndex(section.surface),
    };
  }

  // The key is the fallback identity when a string is missing from the
  // dictionary, which is visible in the output — a silent blank would read as
  // a page that says nothing.
  const lines = section.keys.map((key) => {
    const value = translate(locale, key);
    return `${value === key ? `[missing: ${key}]` : value}`;
  });

  let text = lines.join("\n");
  let truncated = false;
  if (text.length > MAX_PAGE_CHARS) {
    text = `${text.slice(0, MAX_PAGE_CHARS)}\n…（这一页很长，已截断；需要后面���部分请按 topic 再问一次）`;
    truncated = true;
  }

  return { ok: true, topic: `${section.surface}:${section.id}`, title: section.summary, text, truncated };
}
