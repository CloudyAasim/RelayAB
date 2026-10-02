/**
 * tests/unit/assistant-stream-and-media.test.ts
 *
 * Two reports from looking at a real conversation:
 *
 *   1. the first message of a new conversation rendered no answer at all until
 *      the page was reloaded;
 *   2. the assistant looked at its own artefact reference, decided it was an
 *      "internal network URL" the user could not open, and pasted it as
 *      markdown — which a plain-text renderer shows as literal punctuation.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitMediaFromText } from "@/app/(user)/dashboard/assistant/MediaArtifacts";

const SRC = join(process.cwd(), "src");
const CHAT = readFileSync(join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"), "utf-8");
const PROMPTS = readFileSync(join(SRC, "lib", "assistant", "prompts.ts"), "utf-8");

describe("assistant: the first message of a conversation keeps its answer", () => {
  it("does not reload the thread while a turn is streaming", () => {
    // The response headers name the new thread mid-stream, and loading it then
    // reads a conversation that holds only the user's message. That overwrote
    // the local transcript, and every later delta then looked for a streaming
    // placeholder that had just been replaced, so the answer never appeared.
    expect(CHAT).toMatch(
      /useEffect\(\(\) => \{\s*if \(busy\) return;\s*if \(threadId\) void loadThread\(threadId\);/,
    );
  });

  it("settles on the thread the turn actually created", () => {
    // `threadId` inside send() is the value from the render that started the
    // turn, so on a first message it is still null even though the turn made a
    // thread. Reading it from there reloaded nothing and left the streamed
    // transcript without the tool results the stream never carried.
    expect(CHAT).toContain("createdThreadRef");
    expect(CHAT).toMatch(/const settled = createdThreadRef\.current \?\? threadId;/);
  });

  it("records the created thread id as soon as the headers arrive", () => {
    expect(CHAT).toMatch(/createdThreadRef\.current = created;/);
  });
});

describe("assistant: what the model is told about artefact references", () => {
  it("says they are first-party, not an internal address", () => {
    // The transcript showed the model reasoning about a "内网 URL" and about the
    // user being unable to open it, for a path that is the deployment's own.
    expect(PROMPTS).toContain("/api/assistant/artifacts");
    expect(PROMPTS).toMatch(/不是内网地址/);
  });

  it("tells it not to paste a link or markdown image into the answer", () => {
    expect(PROMPTS).toMatch(/不要.*贴裸链接/s);
    expect(PROMPTS).toContain("markdown");
  });
});

describe("assistant: a pasted link is forgiven, a hostile one is not", () => {
  it("lifts an image out of markdown and leaves the prose", () => {
    const { media, text } = splitMediaFromText(
      "图片已生成！\n\n![苹果素描](/api/assistant/artifacts/abc)\n\n这是用 image-01 生成的。",
    );
    expect(media).toEqual(["/api/assistant/artifacts/abc"]);
    expect(text).toContain("图片已生成！");
    expect(text).toContain("这是用 image-01 生成的。");
    // The punctuation that made it look broken is gone.
    expect(text).not.toContain("![");
  });

  it("lifts a bare media link on its own line", () => {
    const { media, text } = splitMediaFromText(
      "看这里：\nhttps://cdn.example/a.png\n就这张。",
    );
    expect(media).toEqual(["https://cdn.example/a.png"]);
    expect(text).toContain("看这里：");
    expect(text).not.toContain("cdn.example");
  });

  it("leaves an ordinary link in the prose", () => {
    const { media, text } = splitMediaFromText("文档在 https://example.com/docs 上。");
    expect(media).toEqual([]);
    expect(text).toContain("https://example.com/docs");
  });

  it("refuses to render a script url", () => {
    // A model response is untrusted input. Whatever it writes must never reach
    // an element's src as something executable.
    for (const hostile of [
      "![x](javascript:alert(1))",
      "![x](data:text/html;base64,PHNjcmlwdD4=)",
      "![x](vbscript:msgbox(1))",
    ]) {
      const { media } = splitMediaFromText(hostile);
      expect(media, `"${hostile}" became a media element`).toEqual([]);
    }
  });

  it("keeps duplicate references to one image", () => {
    const { media } = splitMediaFromText("![a](/x.png)\n\n![b](/x.png)");
    expect(media).toEqual(["/x.png"]);
  });
});
