/**
 * src/lib/search/normalize.ts
 *
 * Turning a vendor's answer into something a model can use.
 *
 * Two rules, and they are rules rather than preferences:
 *
 *   - **A result without a usable URL is not a result.** A hit whose url is
 *     empty, relative, `javascript:`, or carries credentials is dropped. The
 *     assistant's next tool is `fetch_page`, and handing it something it
 *     cannot fetch is worse than handing it one link fewer.
 *   - **Titles and descriptions arrive with markup often enough to matter.**
 *     Tags are stripped and entities decoded, so a snippet reads as text.
 */

/** The handful of entities that actually show up in search results. */
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

export function decodeEntities(value: string): string {
  return value.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");
}

/** Strip markup, decode entities, collapse whitespace, cut to `cap` characters. */
export function plainText(value: unknown, cap: number): string {
  if (typeof value !== "string") return "";
  return decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/** A result URL worth handing to `fetch_page` — and nothing else. */
export function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
