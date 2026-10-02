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
import { splitLinks, toolContentForDisplay } from "@/app/(user)/dashboard/assistant/MediaArtifacts";

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
    expect(PROMPTS).toMatch(/用户的浏览器带着自己的登录态就能打开它/);
  });

  it("tells it not to write the address at all, and gives it something to write instead", () => {
    // Repeating it put the same picture on screen twice, and it then pasted two
    // of them glued into one address that resolves to nothing. So: a flat
    // prohibition, and the alternative the model should reach for — which is
    // what it reached for before, wrongly, because the old paragraph also said
    // "一行 URL 就够了" right beside the prohibition.
    expect(PROMPTS).toMatch(/绝对不要在回答里写出这个地址/);
    expect(PROMPTS).toMatch(/每张一句话/);
    expect(PROMPTS).not.toMatch(/一行 URL 就够了/);
  });

  it("tells it not to invent a pixel count it was never given", () => {
    // A turn reported "1792×1024" — a key in the spec's size table, which is
    // the requested size. The pictures came back 1280×720.
    expect(PROMPTS).toMatch(/像素尺寸它没有给/);
    expect(PROMPTS).toMatch(/把 spec 里的请求尺寸当成出图结果/);
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

  it("makes a root-relative path clickable, which is how the model writes one", () => {
    // Observed: the assistant narrating "URL 是 /api/assistant/artifacts/0000…"
    // and it sitting in the prose as plain text, because only absolute
    // addresses were being recognised.
    const segments = splitLinks(
      "成功生成了图片。URL 是 /api/assistant/artifacts/00001xCbuADbfhtSefPSROZ6ZM",
    );
    const links = segments.filter((s) => s.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      value: "/api/assistant/artifacts/00001xCbuADbfhtSefPSROZ6ZM",
      label: "/api/assistant/artifacts/00001xCbuADbfhtSefPSROZ6ZM",
    });
  });

  it("does not mistake ordinary prose for a path", () => {
    // A lone slash, a date, and a fraction are not links.
    for (const prose of ["用 image-01 生成的，耗时 17 秒", "3 / 4 完成", "没有路径"] ) {
      const links = splitLinks(prose).filter((s) => s.kind === "link");
      expect(links, `"${prose}" produced a link`).toEqual([]);
    }
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
    // Scoped to AssistantBody: `MediaArtifacts` in the same file *should*
    // render an <img> — that is the tool result, and it is the one place a
    // picture belongs.
    const start = BODY.indexOf("export function AssistantBody");
    const end = BODY.indexOf("export function ToolResultCard");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(BODY.slice(start, end)).not.toContain("<img");
  });

  it("renders the picture in exactly one place: the tool result", () => {
    const start = BODY.indexOf("export function MediaArtifacts");
    expect(BODY.slice(start)).toContain("<img");
  });
});

describe("assistant: the tool row", () => {
  it("drops the artefact array from the JSON it shows", () => {
    // The picture is on screen directly above; the raw array is the same link
    // a second time, in a worse form.
    const shown = toolContentForDisplay(
      JSON.stringify({
        ok: true,
        via: "account",
        itemCount: 1,
        artifacts: [{ id: "a1", kind: "image", url: "/api/assistant/artifacts/a1" }],
      }),
    );
    expect(shown).not.toContain("artifacts");
    expect(shown).toContain("itemCount");
  });

  it("leaves a result with nothing to hide untouched", () => {
    expect(toolContentForDisplay('{"ok":true,"via":"account"}')).toContain("via");
  });

  it("shows a refusal as the prose it is", () => {
    const refusal = "没有可用于本部署的凭据，无法发起真实调用。";
    expect(toolContentForDisplay(refusal)).toBe(refusal);
  });
});

describe("assistant: the history drawer", () => {
  it("separates the new-chat action from the list below it", () => {
    // space-y-1 made a 28px button and the first row read as one block.
    expect(CHAT).toMatch(/<Button\s+variant="outline"\s+className="mb-2 w-full justify-start"/);
  });

  it("gives each row a tappable height", () => {
    expect(CHAT).toContain("px-2 py-2 text-left text-sm leading-snug");
  });
});
