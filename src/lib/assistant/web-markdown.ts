/**
 * src/lib/assistant/web-markdown.ts
 *
 * HTML → Markdown, for a page that somebody has to read.
 *
 * The other search APIs hand back Markdown rather than stripped text, and the
 * difference is not cosmetic: a heading, a link and a list are **structure**,
 * and structure is what tells a model what a page *is*. Stripped text turns a
 * documentation page into a wall of sentences — the same sentences, with the
 * part that says "this is the request body" missing.
 *
 * It is not a parser and not a renderer. It is a converter for the markup
 * pages actually use, written out rather than pulled in as a dependency,
 * because this repository keeps its Markdown handling dependency-free for
 * exactly the same reason: the conversion is a page's worth of text, and a
 * library that pulls a parser in with it is a library that has to be kept
 * current for a job that is done in one pass.
 *
 * **What it does not do is decide what matters on the page.** The navigation,
 * the cookie banner and the footer are all still there. Picking them apart
 * needs to know what the site is, and a converter that guessed would take the
 * reference table with it — a page that lost its content is worse than a page
 * that kept its clutter.
 */

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
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&middot;": "·",
  "&times;": "×",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&laquo;": "«",
  "&raquo;": "»",
  "&deg;": "°",
  "&plusmn;": "±",
  "&frac12;": "½",
  "&frac14;": "¼",
  "&frac34;": "¾",
  "&sup2;": "²",
  "&sup3;": "³",
  "&micro;": "µ",
  "&para;": "¶",
  "&sect;": "§",
  "&bull;": "•",
  "&dagger;": "†",
  "&euro;": "€",
  "&pound;": "£",
  "&yen;": "¥",
  "&cent;": "¢",
};

/** The entities a numeric reference names, with or without the semicolon. */
function decodeNumericEntity(body: string): string {
  const code = body.startsWith("#")
    ? body.startsWith("#x") || body.startsWith("#X")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10)
    : Number.NaN;
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return `&${body};`;
  try {
    return String.fromCodePoint(code);
  } catch {
    return `&${body};`;
  }
}

/** The characters a page writes as entities, put back as themselves. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
    const named = ENTITIES[`&${body.toLowerCase()};`];
    if (named !== undefined) return named;
    if (body.startsWith("#")) return decodeNumericEntity(body);
    // An entity this table does not know is left alone: it may be a word.
    return match;
  });
}

/** A placeholder for a block that has already been converted. */
const token = (index: number): string => `\u0000${index}\u0000`;

/**
 * The contents of a `<pre>` block, as a fenced code block.
 *
 * The language comes from the class when the page states one
 * (`class="language-python"`), because a fenced block that says which language
 * it is saves the reader from guessing. It is looked for on the `<pre>` **and**
 * on the `<code>` inside it, because the class is usually on the inner one.
 */
function codeFence(attrs: string, inner: string): string {
  const languageClass = /class\s*=\s*["'][^"']*\b(?:language|lang)-([a-zA-Z0-9+#-]+)/i;
  const language =
    languageClass.exec(attrs)?.[1] ?? languageClass.exec(inner)?.[1] ?? "";
  const body = decodeEntities(
    inner
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/^\n+/, "")
      .replace(/\s+$/, ""),
  );
  return `\`\`\`${language}\n${body}\n\`\`\``;
}

/** One element the converter has to remember while it walks the tags. */
interface OpenLink {
  href: string;
  /** Where the link's text began, so it can be wrapped afterwards. */
  start: number;
}

/** The tag a rule matches, and what it does. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** The tags whose contents are never content. */
const DROPPED_WITH_CONTENT = /<(script|style|noscript|svg|iframe|template|head|canvas)\b[\s\S]*?<\/\1>/gi;

/**
 * Convert an HTML page into Markdown.
 *
 * The walk is a **tag scanner**, not a pile of nested replacements: a page
 * nests lists inside lists inside table cells, and replacements that match
 * from the outside in take the wrong closing tag with them.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";

  const codes: string[] = [];
  let working = html;

  // The code blocks come out first: what is inside them is text that must not
  // be touched by any of the rules below.
  working = working.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_m, attrs: string, inner: string) => {
    codes.push(codeFence(attrs ?? "", inner ?? ""));
    return token(codes.length - 1);
  });

  // Then the parts that are not content at all.
  working = working.replace(/<!--[\s\S]*?-->/g, "");
  working = working.replace(DROPPED_WITH_CONTENT, "");
  working = working.replace(/<(script|style|noscript|svg|iframe|template|head|canvas)\b[^>]*>/gi, "");

  const parts = working.split(/(<[^>]*>)/);
  const links: OpenLink[] = [];
  /** How many items the ordered list currently open has already counted. */
  const ordered: number[] = [];
  let out = "";

  for (const part of parts) {
    if (!part.startsWith("<")) {
      out += decodeEntities(part);
      continue;
    }

    const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)\/?\s*>$/.exec(part);
    if (!match) continue;

    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag[1]);
        out += closing ? "\n\n" : `\n\n${"#".repeat(level)} `;
        continue;
      }
      case "br": {
        out += "\n";
        continue;
      }
      case "hr": {
        out += "\n\n---\n\n";
        continue;
      }
      case "ul":
      case "ol": {
        if (closing) {
          out += "\n";
          ordered.pop();
        } else {
          out += "\n";
          if (tag === "ol") ordered.push(0);
        }
        continue;
      }
      case "li": {
        if (closing) {
          out += "\n";
          continue;
        }
        const depth = ordered.length - 1;
        if (depth >= 0) {
          ordered[depth] += 1;
          // A nested list restarts the numbering of the list below it.
          for (let i = depth + 1; i < ordered.length; i++) ordered[i] = 0;
          out += `${"  ".repeat(depth)}${ordered[depth]}. `;
        } else {
          out += "- ";
        }
        continue;
      }
      case "a": {
        if (closing) {
          const link = links.pop();
          if (!link) continue;
          const inner = out.slice(link.start);
          out = out.slice(0, link.start);
          const label = inner.trim();
          if (!label) continue;
          out += link.href ? `[${label}](${link.href})` : label;
          continue;
        }
        const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        links.push({ href: href.trim(), start: out.length });
        continue;
      }
      case "strong":
      case "b": {
        out += closing ? "**" : "**";
        continue;
      }
      case "em":
      case "i": {
        out += closing ? "*" : "*";
        continue;
      }
      case "code":
      case "kbd":
      case "samp": {
        out += closing ? "`" : "`";
        continue;
      }
      case "img": {
        if (closing) continue;
        const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
        if (src) out += `![${alt}](${src})`;
        continue;
      }
      case "blockquote": {
        out += closing ? "\n" : "\n> ";
        continue;
      }
      case "td":
      case "th": {
        out += closing ? " " : " | ";
        continue;
      }
      case "tr": {
        out += closing ? "\n" : "\n";
        continue;
      }
      default: {
        if (!BLOCK_TAGS.has(tag)) continue;
        if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
          out += closing ? "\n\n" : "\n\n";
        } else if (!closing) {
          out += "\n";
        }
        continue;
      }
    }
  }

  let markdown = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)] ?? "");

  // Tidy: the rules above are generous with blank lines, and a page that ends
  // up with four of them between every sentence is not a page anybody reads.
  markdown = markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return markdown;
}
