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
import { splitLinks } from "@/app/(user)/dashboard/assistant/MediaArtifacts";

const SRC = join(process.cwd(), "src");
const CHAT = readFileSync(join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"), "utf-8");
const BODY = readFileSync(
  join(SRC, "app", "(user)", "dashboard", "assistant", "MediaArtifacts.tsx"),
  "utf-8",
);
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

  it("tells it not to repeat the reference, and how to give a link instead", () => {
    // Repeating it is what put the same picture on screen twice.
    expect(PROMPTS).toMatch(/不要再在回答里重复引用它/);
    expect(PROMPTS).toMatch(/出现两次/);
    // A bare URL is fine and renders as a link; markdown image syntax is not.
    expect(PROMPTS).toMatch(/可点击的链接/);
  });
});

describe("assistant: prose carries links, never a second picture", () => {
  it("turns a redundant image reference into a link, not another picture", () => {
    // The artefact is already rendered by the tool message above. An earlier
    // version rendered it a second time here, so every generated image showed
    // up twice.
    const segments = splitLinks(
      "图片已生成！\n\n![苹果素描](/api/assistant/artifacts/abc)\n\n这是用 image-01 生成的。",
    );
    const links = segments.filter((s) => s.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      value: "/api/assistant/artifacts/abc",
      label: "苹果素描",
    });
    const text = segments.map((s) => s.value).join("");
    expect(text).toContain("图片已生成！");
    expect(text).not.toContain("![");
  });

  it("makes a bare link clickable and shows its address", () => {
    const links = splitLinks("链接：https://example.com/a.png 就这个").filter((s) => s.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ value: "https://example.com/a.png", label: "https://example.com/a.png" });
  });

  it("leaves prose with no URL exactly as it was", () => {
    const segments = splitLinks("已经生成好了，提示词是「戴帽子的猫」。");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: "text", value: "已经生成好了，提示词是「戴帽子的猫」。" });
  });

  it("refuses a script url", () => {
    // A model response is untrusted input. Whatever it writes must never reach
    // an href as something executable.
    for (const hostile of [
      "![x](javascript:alert(1))",
      "看这个 [点](javascript:alert(1))",
      "![x](data:text/html;base64,PHNjcmlwdD4=)",
    ]) {
      const links = splitLinks(hostile).filter((s) => s.kind === "link");
      expect(links, `"${hostile}" became a link`).toEqual([]);
    }
  });

  it("never renders a picture element in an assistant message", () => {
    // The whole point of the change, stated where a future edit cannot miss it.
    // Scoped to AssistantBody's own text: `MediaArtifacts` in the same file
    // *should* render an <img> — that is the tool result, and it is the one
    // place a picture belongs.
    const start = BODY.indexOf("export function AssistantBody");
    const end = BODY.indexOf("export function MediaArtifacts");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = BODY.slice(start, end);
    expect(body).toContain("splitLinks");
    expect(body).not.toContain("<img");
  });

  it("renders the picture in exactly one place: the tool result", () => {
    const start = BODY.indexOf("export function MediaArtifacts");
    expect(BODY.slice(start)).toContain("<img");
  });
});
