import { describe, it, expect } from "vitest";
import { markdownToHtml, markdownToPlainText } from "@/lib/markdown";

describe("markdownToHtml", () => {
  it("renders headings, paragraphs and inline marks", () => {
    const html = markdownToHtml("## Title\n\nHello **bold** and `code`.");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code");
    expect(html).toContain("code</code>");
  });

  it("keeps fenced code verbatim and does not format inside it", () => {
    const html = markdownToHtml('```jsonc\n{ "a": "**not bold**" }\n```');
    expect(html).toContain("<pre><code");
    expect(html).toContain("**not bold**");
    expect(html).not.toContain("<strong>");
  });

  it("renders pipe tables", () => {
    const html = markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("renders ordered and unordered lists", () => {
    const html = markdownToHtml("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("escapes HTML in the source", () => {
    const html = markdownToHtml('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not let a stray number in prose be eaten by the code placeholder", () => {
    // Regression: the inline-code sentinel must not be a bare space/digits pair,
    // or ordinary text like "wait 5 minutes" would be mangled.
    const html = markdownToHtml("wait 5 minutes for `x` plus 5 more");
    expect(html).toContain("wait 5 minutes");
    expect(html).toContain("plus 5 more");
  });

  it("turns links into safe external anchors", () => {
    const html = markdownToHtml("[docs](./a/b.md)");
    expect(html).toContain('href="./a/b.md"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe("markdownToPlainText", () => {
  it("strips syntax but keeps the words", () => {
    const plain = markdownToPlainText(
      "## Title\n\n- **bold** item with `code`\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(plain).toContain("Title");
    expect(plain).toContain("• bold item with code");
    expect(plain).not.toContain("#");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("`");
    expect(plain).not.toContain("|");
  });

  it("drops link targets but keeps the label", () => {
    expect(markdownToPlainText("see [the guide](https://x.test/g) now")).toBe(
      "see the guide now",
    );
  });
});
