/**
 * The thinking has to arrive, and the answer must not be carrying it.
 *
 * Two shapes reach the stream and they were handled as one. MiniMax sends
 * reasoning in its own field; other vendors wrap the answer in `<think>` tags.
 * Reading only `delta.content` treated the first as silence — the model thought,
 * the tokens were billed, nothing reached the screen — and the second as prose,
 * so the model's private reasoning printed in the middle of its answer. Neither
 * looked like the same defect, which is why it survived.
 *
 * The body already had a styled, collapsible block with a summary that says what
 * clicking it does. It had nothing to put in it. Its own comment said so.
 */
import { describe, expect, it } from "vitest";
import { makeThinkingSplitter } from "@/lib/assistant/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

/** Feed a whole answer through the splitter in pieces and rebuild both halves. */
function split(chunks: string[]): { reasoning: string; text: string } {
  const take = makeThinkingSplitter();
  let reasoning = "";
  let text = "";
  for (const c of chunks) {
    const r = take(c);
    reasoning += r.reasoning;
    text += r.text;
  }
  return { reasoning, text };
}

describe("a vendor that inlines its thinking", () => {
  const ANSWER = "<think>let me work through this</think>The answer is 4.";

  it("separates the two halves", () => {
    const out = split([ANSWER]);
    expect(out.reasoning).toBe("let me work through this");
    expect(out.text).toBe("The answer is 4.");
  });

  it("survives the tag being split across deltas", () => {
    // The realistic case: a token boundary lands inside the tag, which a
    // per-chunk regex cannot see.
    const out = split(["<thi", "nk>let me work", " through this</thi", "nk>The answer is 4."]);
    expect(out.reasoning).toBe("let me work through this");
    expect(out.text).toBe("The answer is 4.");
  });

  it("handles several blocks, and text between them", () => {
    // One chunk can carry more than one block, with answer text in between. A
    // version that returned on the first close left the second block's tags in
    // the answer — the private reasoning printed mid-response, which is the
    // symptom this whole file is about.
    const out = split([ANSWER + " Middle. <think>and again</think> End."]);
    expect(out.reasoning).toBe("let me work through thisand again");
    expect(out.text).toBe("The answer is 4. Middle.  End.");
  });

  it("leaves a plain answer alone", () => {
    const out = split(["just ", "an answer"]);
    expect(out.reasoning).toBe("");
    expect(out.text).toBe("just an answer");
  });

  it("gives two turns separate state", () => {
    // The reason the state is a closure and not a module variable. Two turns in
    // flight would share one half-open tag, and the second would print its
    // answer into the first one's reasoning — a worse artefact than either
    // losing it or showing it in the wrong place.
    const a = makeThinkingSplitter();
    a("<think>one"); // left open on purpose
    const b = makeThinkingSplitter();
    expect(b("plain text").text).toBe("plain text");
    expect(a("</think>answer").reasoning).toBe("one");
  });
});

describe("the reasoning reaches the screen", () => {
  const CLIENT = read("src", "lib", "assistant", "client.ts");
  const CHAT = read("src", "lib", "assistant", "chat.ts");
  const UI = read("src", "app", "(user)", "dashboard", "assistant", "MediaArtifacts.tsx");

  it("the stream reads the field the vendor sends it in", () => {
    expect(CLIENT).toMatch(/delta\?\.reasoning_content \?\? choice\.delta\?\.reasoning/);
  });

  it("and it is a separate event, not folded into the text", () => {
    expect(CLIENT).toMatch(/onReasoning\?\./);
    expect(CHAT).toMatch(/onReasoning: \(delta\) => emit\(\{ type: "reasoning"/);
  });

  it("the body takes it as its own prop, rather than parsing it back out", () => {
    // It used to call splitThinkingParts on the answer. That is unrecoverable
    // for a vendor that sends it separately, and it is what left a styled
    // thinking block with nothing to show.
    expect(UI).toMatch(/reasoning\?: string;/);
    expect(UI).toMatch(/\{reasoning \? <div className="opacity-70">\{reasoning\}<\/div>/);
  });

  it("and it is kept, so a reload shows the same turn", () => {
    // Live display without storage reads as the assistant hiding it: the
    // reasoning is there during the turn and gone afterwards.
    expect(read("src", "lib", "db", "sqlite.ts")).toMatch(
      /table: "assistant_messages", column: "reasoning"/,
    );
    expect(CHAT).toMatch(/reasoning: turn\.reasoning \|\| null/);
    expect(read("src", "lib", "assistant", "schema.ts")).toMatch(
      /reasoning: \(row\.reasoning as string \| null\) \?\? null/,
    );
  });

  it("collapsed by default, and not a control the reader cannot hold", () => {
    // It was `open={streaming}` so the reasoning would be readable as it
    // arrived. That made the element controlled: React wrote the prop over the
    // reader's own state on every re-render, so opening it mid-stream was undone
    // by the next token. A disclosure that shuts itself while you are reading it
    // is not a disclosure.
    expect(UI, "a details is force-opened").not.toMatch(/<details[^>]*\bopen=/);
    // Nothing left holding it open either: a prop that outlived its purpose is
    // the next thing nobody reads.
    expect(UI).not.toMatch(/stillStreaming/);
    expect(UI).not.toMatch(/streaming\?: boolean/);
  });
});
