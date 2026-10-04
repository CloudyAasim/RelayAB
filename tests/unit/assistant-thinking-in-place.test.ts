/**
 * tests/unit/assistant-thinking-in-place.test.ts
 *
 * With rendering on, the reasoning was stacked above the answer.
 *
 * `splitThinking` used `String.replace` to lift every `<think>…</think>` out
 * into an array and hand back one answer string. That threw away *where* each
 * block had been: all it could return was "the blocks" and "the rest", in no
 * particular arrangement, so the renderer drew the blocks first and the prose
 * after them. A model that thinks, answers, thinks again and answers again had
 * its second block of reasoning — and its second answer, which followed it —
 * rendered above the first question that answer was answering.
 *
 * The two-pool shape is kept, because a transcript search and these tests want
 * it; what is pinned is that rendering uses the ordered form, and that the
 * ordered form really does interleave.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitThinkingParts, splitThinking } from "@/app/(user)/dashboard/assistant/MediaArtifacts";

const ROOT = process.cwd();
const ARTIFACTS = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "MediaArtifacts.tsx"),
  "utf-8",
);

const INTERLEAVED =
  "先确认一下需求。<think>用户要一张图。</think>好的，我选 image-01。" +
  "<think>再核对一遍比例。</think>已按 16:9 生成。";

describe("reasoning stays where the model put it", () => {
  it("the parts come back interleaved, in the order they were written", () => {
    expect(splitThinkingParts(INTERLEAVED).map((p) => p.kind)).toEqual([
      "text",
      "thinking",
      "text",
      "thinking",
      "text",
    ]);
  });

  it("each block of prose keeps only its own sentence", () => {
    const text = splitThinkingParts(INTERLEAVED)
      .filter((p) => p.kind === "text")
      .map((p) => p.value.trim());
    expect(text).toEqual(["先确认一下需求。", "好的，我选 image-01。", "已按 16:9 生成。"]);
  });

  it("an answer that opens with thinking has no empty prose part in front of it", () => {
    const parts = splitThinkingParts("<think>先想。</think>答。");
    expect(parts).toEqual([
      { kind: "thinking", value: "先想。" },
      { kind: "text", value: "答。" },
    ]);
  });

  it("a message that is nothing but reasoning still renders it", () => {
    expect(splitThinkingParts("<think>只有推理</think>").map((p) => p.kind)).toEqual([
      "thinking",
    ]);
  });

  it("a message with no reasoning is one prose part", () => {
    expect(splitThinkingParts("就是一句话。")).toEqual([
      { kind: "text", value: "就是一句话。" },
    ]);
  });

  it("an unterminated think block is treated as running to the end", () => {
    // A truncated stream is the common case, not the exotic one.
    const parts = splitThinkingParts("<think>说到一半就断了");
    expect(parts.filter((p) => p.kind === "thinking")).toHaveLength(1);
    expect(parts.filter((p) => p.kind === "text")).toHaveLength(0);
  });

  it("and the two-pool form still answers both questions at once", () => {
    const { thinking, answer } = splitThinking(INTERLEAVED);
    expect(thinking).toEqual(["用户要一张图。", "再核对一遍比例。"]);
    expect(answer).toBe("先确认一下需求。\n\n好的，我选 image-01。\n\n已按 16:9 生成。");
  });
});

describe("the renderer draws them in that order", () => {
  it("it maps over the ordered parts, not over a list of blocks", () => {
    // The regression in one assertion: `thinking.map(...)` followed by a single
    // `<Prose text={answer} />` is the shape that stacked them.
    expect(ARTIFACTS).toMatch(/const parts = splitThinkingParts\(text\)/);
    const body = ARTIFACTS.slice(ARTIFACTS.indexOf("export function AssistantBody"));
    expect(body).not.toMatch(/splitThinking\(text\)/);
    expect(body).toMatch(/part\.kind === "thinking"/);
  });

  it("and the summary says that clicking it opens it", () => {
    // `expandLabel` and `collapseLabel` were passed into this component and
    // never used. The block showed a heading, the browser's small triangle, and
    // nothing else, so it read as a section with nothing under it — which is
    // how "the thinking disappeared" was reported by someone who could see it.
    const body = ARTIFACTS.slice(ARTIFACTS.indexOf("export function AssistantBody"));
    expect(body).toMatch(/\{expandLabel\}/);
    expect(body).toMatch(/\{collapseLabel\}/);
    expect(body).toMatch(/group-open:hidden/);
  });
});
