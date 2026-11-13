/**
 * tests/unit/docs-code-contrast.test.ts
 *
 * A code sample has to be readable in both themes.
 *
 * The typography plugin ships one palette: body text near-black, and a fenced
 * block that is **light text on a dark background**. The docs pages override the
 * block's *background* (`prose-pre:bg-foreground/[0.03]`) and nothing else, so in
 * light mode the block became pale grey text on near-white — the sample was
 * there and unreadable. Dark mode looked right by accident, which is why it
 * shipped (reported 2026-11-13).
 *
 * The fix belongs in one place: `globals.css` ties the whole prose palette to
 * the app's theme tokens, in both the normal and `invert` variable sets. These
 * guards keep it there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const CSS = read("src", "app", "globals.css");
const PARAMETERS = read("src", "app", "(user)", "dashboard", "docs", "DocsParameters.tsx");
const PROTOCOL = read("src", "components", "docs", "ProtocolReference.tsx");
const DOCS = read("src", "app", "(user)", "dashboard", "docs", "DocsContent.tsx");

describe("prose code blocks follow the theme", () => {
  it("binds the fenced-block colours to theme tokens, both ways", () => {
    // Normal set: DocsParameters has no `prose-invert`.
    expect(CSS).toContain("--tw-prose-pre-code: var(--foreground)");
    // Invert set: ProtocolReference uses `dark:prose-invert`.
    expect(CSS).toContain("--tw-prose-invert-pre-code: var(--foreground)");
    // The body text too — a parameter guide written in near-black on a dark
    // page is the same bug in the other direction.
    expect(CSS).toContain("--tw-prose-body: var(--foreground)");
    expect(CSS).toContain("--tw-prose-invert-body: var(--foreground)");
  });

  it("does not leave the plugin's dark-on-light block background in charge", () => {
    expect(CSS).toContain("--tw-prose-pre-bg: transparent");
    expect(CSS).toContain("--tw-prose-invert-pre-bg: transparent");
  });

  it("both prose containers pick the override up", () => {
    for (const [name, source] of [
      ["DocsParameters", PARAMETERS],
      ["ProtocolReference", PROTOCOL],
    ] as const) {
      expect(source, name).toMatch(/\bprose prose-sm\b/);
    }
  });

  it("and the hand-written code block states its colour explicitly", () => {
    // DocsContent renders `pre` itself rather than going through prose.
    const block = DOCS.slice(DOCS.indexOf("function CodeBlock"));
    expect(block.slice(0, 800)).toContain("text-foreground");
    expect(block.slice(0, 800)).not.toMatch(/text-(white|gray-[123]00|zinc-[123]00)/);
  });
});
