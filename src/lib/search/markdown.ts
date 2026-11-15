/**
 * src/lib/search/markdown.ts
 *
 * Search results as Markdown, the shape a chat model can cite and a person can
 * read: a numbered list of links with a snippet under each, and a footer saying
 * where they came from.
 *
 * This is deliberately a pure function of the results. The same rendering is
 * used by `POST /v1/search?format=markdown` and by the test page's preview, so
 * "what the API returns" and "what the panel shows" cannot drift.
 */

export interface MarkdownSearchResult {
  title?: string;
  url: string;
  snippet?: string;
  site_name?: string;
  date?: string;
  content?: string;
}

/** One line, no hard breaks that would break the list. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Escape the characters that would end a link or start emphasis. */
function escapeLinkText(value: string): string {
  return oneLine(value).replace(/([\\[\]])/g, "\\$1");
}

function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export interface MarkdownOptions {
  /** The backend that answered, if the caller knows it. */
  provider?: string;
  /** When true, include each result's `content`/`snippet` in full. */
  detailed?: boolean;
}

/**
 * Render search results as Markdown.
 *
 * The numbering is 1-based and stable, so a caller that cites `[1]` cites the
 * first item of this exact string. Title is the link text; the URL is visible
 * beneath it, because a Markdown list whose links are only in the title is
 * useless once pasted somewhere that strips links.
 */
export function searchResultsToMarkdown(
  query: string,
  results: MarkdownSearchResult[],
  options: MarkdownOptions = {},
): string {
  const lines: string[] = [`# Search results: ${oneLine(query)}`, ""];

  results.forEach((result, index) => {
    const title = escapeLinkText(result.title?.trim() || result.url);
    const source = result.site_name?.trim() || domainOf(result.url);
    const meta = [source, result.date?.trim()].filter(Boolean).join(" · ");

    lines.push(`${index + 1}. **[${title}](${result.url})**`);
    if (meta) lines.push(`   - ${meta}`);
    const body = options.detailed ? (result.content ?? result.snippet) : result.snippet;
    if (body?.trim()) {
      lines.push(`   - ${oneLine(body)}`);
    }
    lines.push("");
  });

  if (results.length === 0) {
    lines.push("_No results._", "");
  }

  const footer = [`${results.length} result${results.length === 1 ? "" : "s"}`];
  if (options.provider) footer.push(`from ${options.provider}`);
  footer.push("returned by this deployment's search");
  lines.push(`> ${footer.join(", ")}`);

  return `${lines.join("\n").trim()}\n`;
}
