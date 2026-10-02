/**
 * tests/unit/assistant-artifact-claims.test.ts
 *
 * What the answer is allowed to say about a generated picture.
 *
 * Observed, after a turn that worked: both wallpapers came back and the panel
 * showed them, and the answer said
 *
 *     横屏 16:9 (1792×1024)：
 *     竖屏 9:16 (1024×1792)：
 *
 * with nothing after either colon, and the two artefact addresses written
 * above them glued into a single string that resolves to nothing.
 *
 * Two separate failures in three lines:
 *
 *  - **1792×1024 was invented.** It is a key in the spec's size table — the
 *    *requested* size. The pictures were 1280×720 and 720×1280. Nothing in the
 *    tool result carries pixel dimensions, so the model filled the gap from
 *    something it had read rather than from anything it had been told.
 *  - **The addresses were pasted, twice, glued.** The prompt already said not
 *    to repeat them, and then it also said "一行 URL 就够了" — which granted
 *    permission in the same paragraph that forbade it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitLinks } from "@/app/(user)/dashboard/assistant/MediaArtifacts";
import { MINIMAX_IMAGE_SPEC } from "@/lib/media/seeds";

const PROMPTS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "prompts.ts"), "utf-8");
const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

const SHARED = PROMPTS.slice(
  PROMPTS.indexOf("关于工具返回的 artifacts"),
  PROMPTS.indexOf("你不具备管理员权限"),
);

describe("the answer is not allowed to paste artefact addresses", () => {
  it("does not grant permission to, in the same breath", () => {
    // The sentence that undid the rule beside it.
    expect(SHARED).not.toMatch(/一行 URL 就够了/);
    expect(SHARED).not.toMatch(/它会渲染成可点击的链接/);
  });

  it("says it plainly, and says what to write instead", () => {
    // A prohibition with no alternative gets obeyed no better than one with a
    // wrong alternative; the alternative is what the model reaches for.
    expect(SHARED).toMatch(/绝对不要在回答里写出这个地址/);
    expect(SHARED).toMatch(/每张一句话/);
  });

  it("warns about the gluing, because two addresses is where it happened", () => {
    expect(SHARED).toMatch(/连在一起写/);
    expect(SHARED).toMatch(/拼成一个/);
  });

  it("is told again in the tool result, at the moment it decides", () => {
    // The system prompt was obeyed nowhere, and the tool result is the last
    // thing read before the decision.
    expect(TOOLS).toMatch(/const ARTIFACT_NOTE/);
    expect(TOOLS).toMatch(/note: ARTIFACT_NOTE/);
    const note = TOOLS.slice(TOOLS.indexOf("const ARTIFACT_NOTE"));
    expect(note.slice(0, 700)).toMatch(/不要把 artifacts 里的地址写进回答/);
  });
});

describe("and not to state a number it was never given", () => {
  it("says the tool does not carry pixel dimensions", () => {
    expect(SHARED).toMatch(/像素尺寸它没有给/);
  });

  it("separates the requested size from the result, which is the trap", () => {
    // 1792x1024 is in the spec and the output was 1280x720. The prompt has to
    // name that difference, or "the size in the spec" reads as "the size you
    // got".
    expect(SHARED).toMatch(/把 spec 里的请求尺寸当成出图结果/);
    expect(SHARED).toMatch(/请求 1792x1024，回来完全可能是 1280x720/);
  });

  it("points at the one number that is real", () => {
    expect(SHARED).toMatch(/用工具返回的那个字节数/);
  });

  it("and the tool result says the same", () => {
    const note = TOOLS.slice(TOOLS.indexOf("const ARTIFACT_NOTE"));
    expect(note.slice(0, 900)).toMatch(/像素尺寸这里没有给/);
  });
});

describe("what the renderer does with what the model wrote, either way", () => {
  it("two addresses written back to back are still two links", () => {
    // Already fixed, and it is the difference between a reader getting one
    // picture and two. Pinned here because the prompt not doing it is exactly
    // when this has to hold.
    const a = "00001xCj6CkttggfxJxS5ziOgL";
    const b = "00001xCj6ZwDPpN2dWrBJUGKgw";
    const links = splitLinks(`/api/assistant/artifacts/${a}/api/assistant/artifacts/${b}`).filter(
      (s) => s.kind === "link",
    );
    expect(links).toHaveLength(2);
  });

  it("the spec's 16:9 size is a request, not a promise", () => {
    // Stated as a fact about the spec, because that is the shape of the
    // mistake: the table is real, it is just about the other thing. It maps a
    // request onto the ratio the vendor is asked for — nothing in it says what
    // comes back.
    const node = (MINIMAX_IMAGE_SPEC as unknown as { request: { aspect_ratio: { $mapSize: { table: Record<string, string> } } } })
      .request.aspect_ratio.$mapSize.table;
    expect(node["1792x1024"]).toBe("16:9");
    expect(node["1024x1792"]).toBe("9:16");
  });
});
