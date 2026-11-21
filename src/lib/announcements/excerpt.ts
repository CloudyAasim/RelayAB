/**
 * src/lib/announcements/excerpt.ts
 *
 * One line of an announcement's body, for the strip at the top of every page.
 *
 * The banner used to show only the title, which told a reader that something
 * had happened but not what: 「维护通知」 alone could mean tonight or next
 * month. The title names the event, the first sentence says when and why — so
 * the strip carries both, and the full body is one click away.
 *
 * Plain text, not Markdown: the strip is one line and `markdownToHtml` would
 * emit a block element per paragraph. `markdownToPlainText` already exists for
 * exactly this ("what you want when pasting into a chat box"), and reusing it
 * means a heading or a list in the body degrades to words instead of `###`.
 *
 * Collapsed on whitespace because Markdown sources are full of newlines that
 * are meaningful in a paragraph and noise in a single line: a bare `\n` in a
 * `truncate` element renders as a space anyway, but leaving it would make the
 * cut-off point depend on where the author's editor wrapped.
 */
import { markdownToPlainText } from "@/lib/markdown";

/** Longest excerpt kept, in characters. Past this the strip stops being a peek. */
export const MAX_EXCERPT_LENGTH = 160;

/**
 * The first `limit` characters of a body as plain text, or "" when the body has
 * no words (an empty body is legal: a title alone can be the whole notice).
 *
 * Truncation happens on the character count rather than on a word boundary: the
 * result is rendered with `truncate`, which clips by measured pixels, so the
 * only job here is to keep the string small before it reaches the DOM.
 */
export function announcementExcerpt(body: string, limit = MAX_EXCERPT_LENGTH): string {
  const plain = markdownToPlainText(body).replace(/\s+/g, " ").trim();
  if (plain.length <= limit) return plain;
  return plain.slice(0, limit).trimEnd();
}