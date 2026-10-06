/**
 * tests/unit/assistant-inline-code-with-urls.test.ts
 *
 * A sentence with a URL in backticks came out as its punctuation with nothing
 * between it:
 *
 *   接入地址统一为 `https://api.aasim.l.cd`，通过 `/v1/chat/completions`、… 等端点调用。
 *   →  接入地址统一为 、 、 等端点调用。
 *
 * `markdownToHtml` was never the problem — it renders that line correctly on its
 * own. The damage happened one layer earlier: `splitLinks` runs its four matchers
 * over the **raw markdown**, before anything has parsed it, so it took the URL
 * for a bare link, left an orphaned backtick on each side, and `markdownToHtml`
 * then read what was left as an empty code span. Four spans, three empty ones.
 *
 * The same pass also produced `href="https://api.aasim.l.cd`，通过"` — an
 * address assembled out of model output, carrying the backtick and the Chinese
 * comma it should have stopped at.
 */
import { describe, expect, it } from "vitest";

import { splitLinks } from "@/app/(user)/dashboard/assistant/MediaArtifacts";
import { markdownToHtml } from "@/lib/markdown";

/** What `Prose` renders: split first, then markdown each piece. */
function prose(text: string): string {
  return splitLinks(text)
    .map((s) => (s.kind === "link" ? `<a href="${s.value}">${s.label}</a>` : markdownToHtml(s.value)))
    .join("");
}

const REPORTED =
  "接入地址统一为 `https://api.aasim.l.cd`，通过 `/v1/chat/completions`、`/v1/images/generations`、`/v1/audio/speech` 等端点调用。";

describe("a URL inside an inline code span is not a link", () => {
  it("stays inside its backticks, and every span survives", () => {
    const out = prose(REPORTED);
    expect(out).toContain(">https://api.aasim.l.cd<");
    expect(out).toContain(">/v1/chat/completions<");
    expect(out).toContain(">/v1/images/generations<");
    expect(out).toContain(">/v1/audio/speech<");
    // No empty spans, which is what the reader actually saw.
    expect(out).not.toMatch(/<code[^>]*>\s*<\/code>/);
  });

  it("and produces no link at all, code or otherwise", () => {
    // A link here is not a cosmetic problem: `href` was being built from
    // whatever the model wrote next to the address.
    expect(prose(REPORTED)).not.toContain("<a ");
    expect(splitLinks(REPORTED).every((s) => s.kind === "text")).toBe(true);
  });

  it("a bare URL in prose is still a link", () => {
    // The shield is for code, not a change of policy about URLs.
    const out = prose("见 https://api.aasim.l.cd 就能看到。");
    expect(out).toContain('<a href="https://api.aasim.l.cd"');
    expect(out).toContain(">https://api.aasim.l.cd</a>");
  });

  it("a fenced block full of URLs is code, wholesale", () => {
    const src = "这样调用：\n\n```\ncurl https://api.aasim.l.cd/v1/chat/completions\n```\n\n就通了。";
    expect(prose(src)).not.toContain("<a ");
    expect(prose(src)).toContain("https://api.aasim.l.cd/v1/chat/completions");
  });

  it("an artefact path outside code is still a link", () => {
    // The one case the shield must not swallow: the probe hands these back and
    // they have to stay clickable.
    const id = "abcdefghijklmnopqrstuvwxyz";
    const out = prose(`图在 /api/assistant/artifacts/${id} 这里。`);
    expect(out).toContain(`<a href="/api/assistant/artifacts/${id}"`);
  });

  it("and code that happens to look like an artefact path stays code", () => {
    const id = "abcdefghijklmnopqrstuvwxyz";
    const out = prose(`它会返回 \`/api/assistant/artifacts/${id}\` 这个地址。`);
    expect(out).not.toContain("<a ");
    expect(out).toContain(`>/api/assistant/artifacts/${id}<`);
  });

  it("several spans in one line, none of them links", () => {
    const out = prose("用 `a`、`b`、`c` 三个。");
    expect(out).toContain(">a<");
    expect(out).toContain(">b<");
    expect(out).toContain(">c<");
    expect(out).not.toContain("<a ");
  });
});

describe("the shield itself", () => {
  it("cannot be swallowed by the matcher it exists to stop", () => {
    // `BARE_URL` matches `[^\s<>()]+`, which a bare private-use character
    // satisfies. An unpadded sentinel beside a URL would end up inside the href,
    // which is the failure the padding exists to prevent.
    const src = "A";
    const segs = splitLinks(`见 \`x\` 和 https://api.aasim.l.cd 结束`);
    for (const s of segs) {
      if (s.kind === "text") expect(s.value).not.toMatch(/[-]/);
    }
    expect(splitLinks(src).length).toBeGreaterThan(0);
  });

  it("leaves no sentinel behind when there was no code", () => {
    const segs = splitLinks("没有代码的一段普通文字 https://api.aasim.l.cd");
    expect(segs.some((s) => s.kind === "link")).toBe(true);
    for (const s of segs) {
      if (s.kind === "text") expect(s.value).not.toMatch(/[-]/);
    }
  });
});