import { describe, expect, it } from "vitest";

import { splitLinks } from "../../src/app/(user)/dashboard/assistant/MediaArtifacts";

/**
 * Where a link sits in a sentence, not just that it is there.
 *
 * The other link guard asks "are these two links, and did the text around
 * them survive" — and it passed while the renderer produced
 * `<a>https://x</a>见 就能看到。` for input `见 https://x 就能看到。`
 *
 * Both questions were answered by a `push` that appended the link to a list
 * and a space back into the source string, with the leftover prose pushed
 * once at the end. The prose survived, so "did the text survive" was true;
 * the link was still in the list, so "is the link there" was true. Nothing
 * asked about the order, which is the only thing a reader notices.
 *
 * These assert order, because order is the thing that was wrong.
 */
const render = (text: string): string =>
  splitLinks(text)
    .map((s) => (s.kind === "link" ? `[${s.label}]` : s.value))
    .join("");

describe("splitLinks keeps a link where the sentence put it", () => {
  it("puts the link between the words that surrounded it", () => {
    expect(render("见 https://api.aasim.l.cd 就能看到。")).toBe(
      "见 [https://api.aasim.l.cd] 就能看到。",
    );
  });

  it("keeps two links at their own positions, not side by side", () => {
    // The failure this was written for: both links came first, then the prose.
    expect(render("横向：/api/assistant/artifacts/aaa 竖向：/api/assistant/artifacts/bbb")).toBe(
      "横向：[/api/assistant/artifacts/aaa] 竖向：[/api/assistant/artifacts/bbb]",
    );
  });

  it("does not treat a digit in prose as a placeholder", () => {
    // Private-use markers, not a bare index: an answer that says "第 1 步"
    // has digits in it, and a numeric placeholder would swallow them.
    const out = render("见 https://x.com 第 1 步和第 2 步，然后 /v1/chat 接口。");
    expect(out).toContain("第 1 步");
    expect(out).toContain("第 2 步");
    expect(out).toContain("[/v1/chat]");
  });

  it("leaves an unsafe url as prose rather than dropping it", () => {
    // isSafeUrl decides what becomes a link. A rejected one stays where it
    // was, so the sentence around it is still a sentence.
    const out = render("javascript:alert(1) 和 https://ok.example");
    expect(out).toContain("javascript:alert(1)");
    expect(out).toContain("[https://ok.example]");
  });

  it("a markdown image becomes a link at its position, with no literal brackets", () => {
    const out = render("看图 ![示例](https://x.com/a.png) 然后见 https://y.com。");
    expect(out).toBe("看图 [示例] 然后见 [https://y.com]。");
    expect(out).not.toContain("![" );
  });

  it("stops at CJK punctuation, because the answers are in Chinese", () => {
    // The assistant writes Chinese, so this is the shape of nearly every
    // sentence that ends in a link. With ASCII-only boundaries the 。 was
    // taken as part of the address.
    expect(render("见 https://y.com。")).toBe("见 [https://y.com]。");
    expect(render("见 https://y.com，然后配置。")).toBe("见 [https://y.com]，然后配置。");
    expect(render("地址是 https://y.com/path；下一个。")).toBe("地址是 [https://y.com/path]；下一个。");
  });

  it("prose with no links is untouched", () => {
    expect(render("先看文档，再配置，最后验证。")).toBe("先看文档，再配置，最后验证。");
  });
});
