/**
 * src/lib/markdown.ts
 *
 * A deliberately small, dependency-free Markdown renderer.
 *
 * It exists for exactly one job: the admin docs must be able to show the media
 * adapter protocol **from the very same file that lives in the repo**
 * (`docs/模型适配协议/README.md`), so the panel and the repository can never
 * drift apart. Pulling in a full Markdown library (and shipping it to the
 * browser) for that is not worth it.
 *
 * Supported: ATX headings, fenced code, pipe tables, ordered/unordered lists,
 * blockquotes, horizontal rules, paragraphs, and inline code/bold/italic/links.
 * Anything else renders as plain text — and the source is always still
 * available verbatim through the copy buttons, which is what operators paste
 * into an AI assistant.
 */

const CODE_FENCE = /```(\w*)\s*$/;
const CLOSING_FENCE = /^```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const UNORDERED = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const TABLE_SEP = /^\|?[\s:|-]+\|[\s:|-]*$/;
const BLOCK_START = /^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s|\|)/;

/** Placeholder for extracted inline code; NUL cannot occur in Markdown input. */
const CODE_TOKEN = (index: number) => `\u0000${index}\u0000`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline spans, applied after escaping so nothing can inject markup. */
function renderInline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return CODE_TOKEN(codes.length - 1);
  });
  out = escapeHtml(out);
  // A link with no destination is not a link. A model asked to cite a file
  // sometimes writes `[点击查看]()` — and the link regex below requires a
  // target, so it would survive as literal `[点击查看]()`, which reads as a
  // broken control rather than as the words it was trying to say.
  out = out.replace(/\[([^\]]+)\]\(\s*\)/g, "$1");
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label: string, href: string) =>
      `<a href="${href}" target="_blank" rel="noreferrer noopener" class="underline underline-offset-2">${label}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => {
    const code = codes[Number(index)] ?? "";
    return `<code class="rounded bg-muted px-1 py-0.5 text-[0.85em]">${escapeHtml(code)}</code>`;
  });
  return out;
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const codeBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = CODE_FENCE.exec(line);
    if (fence) {
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !CLOSING_FENCE.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      codeBlocks.push(
        `<pre><code data-lang="${escapeHtml(fence[1] || "")}">${escapeHtml(buffer.join("\n"))}</code></pre>`,
      );
      out.push(CODE_TOKEN(codeBlocks.length - 1));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR.test(line.trim())) {
      out.push("<hr />");
      i += 1;
      continue;
    }

    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_SEP.test(lines[i + 1].trim())
    ) {
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${header
          .map((cell) => `<th>${renderInline(cell)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const buffer: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        buffer.push(m[1]);
        i += 1;
      }
      out.push(`<blockquote>${markdownToHtml(buffer.join("\n"))}</blockquote>`);
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = ORDERED.exec(line);
    if (unordered || ordered) {
      const matcher = unordered ? UNORDERED : ORDERED;
      const items: string[] = [];
      while (i < lines.length) {
        const m = matcher.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i += 1;
      }
      out.push(unordered ? `<ul>${items.join("")}</ul>` : `<ol>${items.join("")}</ol>`);
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      i += 1;
      continue;
    }

    const buffer: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START.test(lines[i]) &&
      !HR.test(lines[i].trim())
    ) {
      buffer.push(lines[i]);
      i += 1;
    }
    if (buffer.length > 0) {
      out.push(`<p>${renderInline(buffer.join(" "))}</p>`);
    } else {
      i += 1;
    }
  }

  return out
    .join("\n")
    .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codeBlocks[Number(index)] ?? "");
}

/** Markdown with all syntax removed — what you want when pasting into a chat box. */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
