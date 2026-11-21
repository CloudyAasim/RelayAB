/**
 * tests/unit/announcement-excerpt.test.ts
 *
 * The one-line excerpt the strip shows above the notice's title.
 *
 * Worth its own file because it is the one piece of the banner with logic in
 * it: everything else is class names. The three things that can go wrong are a
 * Markdown sigil leaking into the strip (`### 维护`), an excerpt that is not
 * actually short enough to stay on one line, and an empty body taking the whole
 * strip down with it.
 */
import { describe, it, expect } from "vitest";
import { announcementExcerpt, MAX_EXCERPT_LENGTH } from "@/lib/announcements/excerpt";

describe("announcementExcerpt", () => {
  it("strips Markdown rather than showing its syntax", () => {
    expect(announcementExcerpt("### 维护通知\n\n今晚 **23:00** 起。")).toBe("维护通知 今晚 23:00 起。");
  });

  it("collapses newlines so the strip cannot be pushed to two lines by formatting", () => {
    // A paragraph break in the source is a space in a single-line element; the
    // collapsed form makes the cut-off point independent of where the author's
    // editor happened to wrap.
    expect(announcementExcerpt("第一行\n第二行\n\n第三段")).toBe("第一行 第二行 第三段");
  });

  it("turns a list into words", () => {
    expect(announcementExcerpt("- 第一项\n- 第二项")).toBe("• 第一项 • 第二项");
  });

  it("drops a link's target, keeping its text", () => {
    expect(announcementExcerpt("详见[状态页](https://status.example.com)")).toBe("详见状态页");
  });

  it(`cuts at ${MAX_EXCERPT_LENGTH} characters`, () => {
    const excerpt = announcementExcerpt("字".repeat(MAX_EXCERPT_LENGTH * 2));
    expect(excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
  });

  it("keeps a body shorter than the limit whole", () => {
    const short = "今晚维护，预计十分钟。";
    expect(announcementExcerpt(short)).toBe(short);
  });

  it("returns an empty string for a body with no words", () => {
    // A title-only notice is legal, and the banner must render without a stray
    // separator or a second empty line for it.
    expect(announcementExcerpt("")).toBe("");
    expect(announcementExcerpt("   \n\n  ")).toBe("");
  });

  it("does not leave a space before the cut", () => {
    // `truncate` already adds the ellipsis; a trailing space here would make the
    // gap between the title and the excerpt two spaces wide on some rows only.
    const excerpt = announcementExcerpt(`${"a".repeat(MAX_EXCERPT_LENGTH)} tail`);
    expect(excerpt).toHaveLength(MAX_EXCERPT_LENGTH);
    expect(excerpt.endsWith(" ")).toBe(false);
  });
});