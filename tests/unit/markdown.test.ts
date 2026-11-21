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

describe("line breaks", () => {
  // The default is CommonMark's soft break: the protocol files in `docs/` are
  // hard-wrapped at 80 columns, so a newline in the source is a paragraph line,
  // not a line on screen. Turning it into a `<br>` would shred every sentence.
  it("joins a single newline with a space by default", () => {
    const html = markdownToHtml("第一行\n第二行");
    expect(html).toBe("<p>第一行 第二行</p>");
    expect(html).not.toContain("<br");
  });

  it("keeps a single newline when the surface asks for it", () => {
    // What the admin form promises an operator on `admin.announcements.body`:
    // "line breaks are kept". Regression: the field stored the newlines but the
    // renderer folded them into spaces, so a three-line maintenance notice read
    // as one run-on sentence with only the paragraph count betraying it.
    const html = markdownToHtml("本周日维护。\n期间不可用。\n无需操作。", { breaks: true });
    expect(html).toBe("<p>本周日维护。<br />期间不可用。<br />无需操作。</p>");
  });

  it("still splits on a blank line either way", () => {
    // A blank line is a hard paragraph break in both modes, and it must not
    // leave a `<br>` behind: that would be a blank line the operator did not
    // type, drawn inside the prose.
    for (const options of [{}, { breaks: true }]) {
      const html = markdownToHtml("第一段\n\n第二段", options);
      expect(html.match(/<p>/g)).toHaveLength(2);
      expect(html).not.toContain("<br");
      expect(html).not.toContain("第一段 第二段");
    }
  });

  it("never puts a break inside a code fence or a table", () => {
    // The fence is verbatim text: a `<br>` in it would be a visible character
    // in a block whose whole point is that you can copy it back out.
    const code = markdownToHtml("```\na\nb\n```", { breaks: true });
    expect(code).toContain("<pre><code");
    expect(code).not.toContain("<br");
    const table = markdownToHtml("| a | b |\n| --- | --- |\n| 1 | 2 |", { breaks: true });
    expect(table).not.toContain("<br");
    const list = markdownToHtml("- one\n- two", { breaks: true });
    expect(list).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("does not let the break survive as a visible character", () => {
    // The break travels through `renderInline` as a sentinel because that
    // function escapes its input; the substitution has to happen afterwards and
    // clean up completely.
    for (const html of [
      markdownToHtml("a\nb", { breaks: true }),
      markdownToHtml("> a\n> b", { breaks: true }),
      markdownToHtml("a\nb"),
    ]) {
      expect(html).not.toMatch(/[\u0000-\u0008]/);
    }
    const quote = markdownToHtml("> a\n> b", { breaks: true });
    expect(quote).toBe("<blockquote><p>a<br />b</p></blockquote>");
  });

  it("leaves an escaped newline in prose as text, not markup", () => {
    // `renderInline` escapes before it emits, so prose cannot smuggle a tag in.
    const html = markdownToHtml("<br />\n不是换行", { breaks: true });
    expect(html).toContain("&lt;br /&gt;");
    expect(html.match(/<br \/>/g)).toHaveLength(1);
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
