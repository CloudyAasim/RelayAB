/**
 * tests/unit/assistant-adjacent-artifact-links.test.ts
 *
 * Two pictures, one turn, and the URLs written back to back.
 *
 * Observed: a turn generated two wallpapers, and the answer came out as
 *
 *   /api/assistant/artifacts/AAA/api/assistant/artifacts/BBB
 *
 * — one token where there should be two, and not a real address: the first id
 * had `/api/assistant/artifacts/` glued onto the end of it. The generic
 * root-relative-path matcher treats any run of `/segment/segment` as a single
 * path, so two adjacent ones merge. A link to that address 404s, which means
 * the reader gets one broken link instead of two working ones.
 *
 * The fix is a matcher for *our* paths with a bounded id, run before the
 * generic one: the shape is known, so it does not have to be guessed at.
 */
import { describe, it, expect } from "vitest";
import { splitLinks } from "@/app/(user)/dashboard/assistant/MediaArtifacts";
import { markdownToHtml } from "@/lib/markdown";

const A = "00001xCfNjy626TV1mg2rAMb0m";
const B = "00001xCfO0rJWkiPRnmvXxFm5T";
const PATH = (id: string) => `/api/assistant/artifacts/${id}`;

describe("two artefacts written back to back", () => {
  it("are two links, not one glued address", () => {
    const segments = splitLinks(PATH(A) + PATH(B));
    const links = segments.filter((s) => s.kind === "link");
    expect(links, "the two paths merged into one").toHaveLength(2);
    expect(links.map((l) => l.value)).toEqual([PATH(A), PATH(B)]);
  });

  it("survive being separated by a space, a comma or a newline", () => {
    for (const sep of [" ", "\n", "，", ", "]) {
      const links = splitLinks(PATH(A) + sep + PATH(B)).filter((s) => s.kind === "link");
      expect(links.map((l) => l.value), `separator ${JSON.stringify(sep)}`).toEqual([PATH(A), PATH(B)]);
    }
  });

  it("do not swallow the sentence around them", () => {
    const segments = splitLinks(`横向（16:9）：${PATH(A)} 竖向（9:16）：${PATH(B)}`);
    const text = segments.filter((s) => s.kind === "text").map((s) => s.value).join("");
    expect(text).toContain("横向（16:9）：");
    expect(text).toContain("竖向（9:16）：");
  });

  it("each link points at an address that exists", () => {
    // The whole point: the reader clicks one and gets that picture, not a 404
    // on a path with the other one welded to it.
    for (const link of splitLinks(PATH(A) + PATH(B)).filter((s) => s.kind === "link")) {
      if (link.kind !== "link") continue;
      expect(link.value).toMatch(/^\/api\/assistant\/artifacts\/[0-9A-Za-z]{26}$/);
    }
  });

  it("still recognise a longer path that merely starts the same way", () => {
    // The bound is on our id shape, not on the prefix: a download or a dl=1
    // query is a real link and must not be truncated into a different one.
    const segments = splitLinks(`${PATH(A)}?dl=1`);
    const links = segments.filter((s) => s.kind === "link");
    expect(links[0].value).toBe(`${PATH(A)}?dl=1`);
  });

  it("a markdown link with no target is not a link", () => {
    // The model wrote `[点击查看]()` twice here. Rendered as-is it is literal
    // bracket text the reader cannot use; what they should see is the words.
    // Asserting "no anchor" is not enough — the literal form has no anchor
    // either, and it is the literal form that is the problem.
    const html = markdownToHtml("横向（16:9）：[点击查看]()");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("[");
    expect(html).not.toContain("]");
    expect(html).toContain("点击查看");
  });

  it("leaves a link that has a target alone", () => {
    const html = markdownToHtml("[点我](/docs/usage)");
    expect(html).toContain('href="/docs/usage"');
    expect(html).toContain("点我");
  });

  it("does not eat a bracket that is not a link at all", () => {
    // Arrays and indices are ordinary prose; the cleanup is only for the
    // `[text]()` shape.
    expect(markdownToHtml("用 items[0] 取第一个")).toContain("items[0]");
  });
});

describe("the generic path matcher, still", () => {
  it("finds an ordinary relative path", () => {
    const links = splitLinks("见 /api/admin/providers 这个接口").filter((s) => s.kind === "link");
    expect(links[0].value).toBe("/api/admin/providers");
  });

  it("finds an ordinary relative path with a deeper tail", () => {
    const links = splitLinks("/docs/usage/range?from=2026-01-01").filter((s) => s.kind === "link");
    expect(links[0].value).toBe("/docs/usage/range?from=2026-01-01");
  });

  it("leaves a lone slash and an ordinary word alone", () => {
    expect(splitLinks("和/或 都可以").filter((s) => s.kind === "link")).toHaveLength(0);
  });
});
