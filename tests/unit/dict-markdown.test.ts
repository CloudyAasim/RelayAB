/**
 * tests/unit/dict-markdown.test.ts
 *
 * A dictionary string that carries markdown must be **rendered** as markdown.
 *
 * The dictionary says `**this is the part that matters**` and
 * `` `reasoning_effort` ``. A panel that prints the string prints those
 * markers too — a `<p>` shows what it is given — so the reader was left with
 * the asterisks and the backticks still on.
 *
 * It reached the **public user documentation**, which is where it was found:
 * the search chapter said 「价格由**实际在用的那个搜索服务**自己的定价决定」
 * with the asterisks visible.
 *
 * The rule this file pins: a value with a markdown marker in it has to reach
 * the reader through the renderer. `MarkdownText` is that renderer for a
 * sentence; `markdownToHtml` is it for a block.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Every source file that could render a string — the dictionary is not one. */
const SOURCE_FILES = filesIn(SRC).filter((f) => !f.endsWith(join("i18n", "dict.ts")));

const DICT = readFileSync(join(SRC, "lib", "i18n", "dict.ts"), "utf-8");

/**
 * The keys whose value carries a markdown marker.
 *
 * Both locales are read, because a value that was marked up in one language
 * and not in the other is just as broken in the one that was.
 */
function markedKeys(): string[] {
  const keys = new Set<string>();
  const re = /"([A-Za-z][\w.]*)":\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of DICT.matchAll(re)) {
    const value = match[2];
    if (value.includes("**") || value.includes("`")) keys.add(match[1]);
  }
  return [...keys];
}

describe("a marked-up dictionary string is rendered as markdown", () => {
  const keys = markedKeys();

  it("there are marked-up strings to check", () => {
    // Otherwise the rule below is vacuous, and a dictionary that lost all its
    // markdown would pass a test that no longer knows what it was for.
    expect(keys.length, "no dictionary value carries a markdown marker").toBeGreaterThan(5);
  });

  it("every one of them reaches the reader through the renderer", () => {
    const offenders: string[] = [];

    for (const key of keys) {
      const call = `t("${key}")`;
      for (const file of SOURCE_FILES) {
        const source = readFileSync(file, "utf-8");
        let at = source.indexOf(call);
        if (at === -1) continue;
        while (at !== -1) {
          // The renderer has to be the thing that is doing the printing: look
          // back over the markup that opens the element the string sits in.
          const before = source.slice(Math.max(0, at - 300), at);
          const rendered =
            before.includes("MarkdownText") ||
            before.includes("markdownToHtml") ||
            before.includes("inlineMarkdownToHtml");
          if (!rendered) {
            offenders.push(`${file.replace(ROOT, "")}: ${key}`);
          }
          at = source.indexOf(call, at + call.length);
        }
      }
    }

    expect(
      offenders,
      "a marked-up string printed as plain text shows its markers:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("and the renderer escapes what it is given", () => {
    // The whole reason a dictionary string may carry markup is that it is
    // escaped before it is rendered. Without that, a string could inject an
    // element of its own.
    const markdown = readFileSync(join(SRC, "lib", "markdown.ts"), "utf-8");
    expect(markdown).toContain("export function inlineMarkdownToHtml");
    expect(markdown).toMatch(/function escapeHtml\(value: string\)/);
    // The inline renderer escapes before it emits anything.
    const inline = markdown.slice(markdown.indexOf("export function inlineMarkdownToHtml"));
    expect(inline).toContain("renderInline(text)");
    expect(markdown).toMatch(/out = escapeHtml\(out\)/);
  });
});

describe("the component that does it", () => {
  const component = readFileSync(join(SRC, "components", "i18n", "MarkdownText.tsx"), "utf-8");

  it("renders a span, because the caller decides what it is", () => {
    // A `<p>` inside a `<p>` is not a thing: the browser closes the outer one
    // and starts again, and the paragraph the caller wrote is gone.
    //
    // The comments come off first — the file explains itself in terms of the
    // very tag this is checking for.
    const code = component.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain("<span");
    expect(code).not.toContain("<p");
  });

  it("and it is not a client component", () => {
    // It has no state and no hooks, so making it one would pull the markdown
    // renderer into the client bundle for every page that shows a sentence.
    expect(component).not.toMatch(/^\s*["']use client["']/m);
  });
});
