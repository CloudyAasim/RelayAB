/**
 * tests/unit/assistant-ask-user.test.ts
 *
 * The assistant can ask, and the answer comes back.
 *
 * The reason this exists at all: the free-model gate refuses a proposal whose
 * models are free and says the way out is `confirmFindings`. The way out was a
 * key format — `all_zero:model-id` — that only the assistant knew, so the
 * person asking the question had to be told what to type into the chat box, and
 * the whole refusal was phrased in a language one of the two parties did not
 * speak. Asking is the fix, and asking is only worth having if the question
 * survives a reload: it is stored as a tool row, and without restoring it the
 * transcript comes back from the database with nothing to answer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { executeTool, ASK_USER_MARKER, type ToolResult } from "@/lib/assistant/tools";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

function ask(args: Record<string, unknown>): Promise<ToolResult> {
  return executeTool("ask_user", JSON.stringify(args), { user: { id: "u" } } as never);
}

describe("ask_user", () => {
  it("carries the question out for the screen", async () => {
    const result = await ask({
      question: "glm-4.5 每百万 token 收多少积分？",
      options: ["先按 0 计", "我去查了再回来"],
      placeholder: "输入积分价格",
      hint: "用来填写模型定价",
    });
    expect(result.ok).toBe(true);
    expect(result.askedUser).toEqual({
      question: "glm-4.5 每百万 token 收多少积分？",
      options: ["先按 0 计", "我去查了再回来"],
      placeholder: "输入积分价格",
      hint: "用来填写模型定价",
    });
  });

  it("tells the model to stop rather than to guess", async () => {
    // The failure this guards: the assistant asks, then answers itself, and the
    // interface shows a question and an answer from the same source.
    const result = await ask({ question: "用哪个定价？" });
    expect(result.content).toMatch(/不要调用任何其他工具/);
    expect(result.content).toMatch(/不要.*假设一个答案/);
    // The question itself has to be visible to the model next turn, or it will
    // come back asking again.
    expect(result.content).toContain("用哪个定价？");
  });

  it("keeps the question in the stored row, machine-readable", async () => {
    // This row is the only thing that survives a reload.
    const result = await ask({ question: "价格是多少？", options: ["0"] });
    expect(result.content).toContain(ASK_USER_MARKER);
    const at = result.content.indexOf(ASK_USER_MARKER);
    const parsed = JSON.parse(result.content.slice(at + ASK_USER_MARKER.length).trim());
    expect(parsed).toEqual({ question: "价格是多少？", options: ["0"] });
  });

  it("will not store an empty question", async () => {
    for (const bad of [{}, { question: "   " }, { question: "" }]) {
      const result = await ask(bad);
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
      expect(result.askedUser).toBeUndefined();
    }
  });

  it("caps the option list and each option", async () => {
    // Options become buttons. Twenty of them is not a choice, and an unbounded
    // string is a place to put a paragraph the reader has to read before
    // deciding.
    const many = await ask({ question: "q", options: Array.from({ length: 9 }, (_, i) => `o${i}`) });
    expect(many.ok).toBe(false);
    const long = await ask({ question: "q", options: ["x".repeat(200)] });
    expect(long.ok).toBe(false);
  });

  it("needs only a question — options are for answers that can be enumerated", async () => {
    const result = await ask({ question: "价格是多少？" });
    expect(result.ok).toBe(true);
    expect(result.askedUser?.options).toBeUndefined();
    expect(result.askedUser?.placeholder).toBeUndefined();
  });
});

describe("the two copies of the marker are one constant", () => {
  /**
   * `AssistantChat.tsx` declares its own copy rather than importing from
   * `tools.ts`, because that module is server code and importing it would drag
   * the whole tool catalogue into the browser bundle. The cost of that choice
   * is a string that has to match on both sides, and the cost of not guarding
   * it is a question that vanishes on every reload while looking perfectly fine
   * in development.
   */
  it("the client declares exactly what the server writes", () => {
    const client = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
    const declared = client.match(/const ASK_USER_MARKER = "([^"]+)"/);
    expect(declared, "the client no longer declares its own marker").not.toBeNull();
    expect(declared![1]).toBe(ASK_USER_MARKER);
  });

  it("and it is still a comment, so the model does not read it as an answer", () => {
    expect(ASK_USER_MARKER.startsWith("<!--")).toBe(true);
    expect(ASK_USER_MARKER.endsWith("-->")).toBe(true);
  });
});

describe("the turn loop treats a question as the end of the turn", () => {
  const CHAT = read("src", "lib", "assistant", "chat.ts");

  it("stops the loop on it", () => {
    // A stream cannot carry an answer back in, so continuing would be the model
    // deciding its own answer.
    expect(CHAT).toMatch(/if \(askedQuestion\) break;/);
  });

  it("does not report it as an error", () => {
    // A turn that asked and is waiting has not failed. Painting it red is how a
    // refusal became indistinguishable from a fault.
    const block = CHAT.slice(CHAT.indexOf("if (askedQuestion) {"), CHAT.indexOf("if (!stopReason)"));
    expect(block, "a question ends the turn somewhere else").toContain("if (askedQuestion) {");
    expect(block, "the wait is not reported through the error channel").not.toMatch(
      /type: "error"/,
    );
    expect(block, "done does not say it is waiting").toMatch(/awaitingAnswer: true/);
  });

  it("still persists the tool row before stopping", () => {
    // Stopping first would leave the question nowhere to be restored from.
    const persist = CHAT.indexOf('appendAssistantMessage({\n        threadId: thread.id,\n        role: "tool"');
    const stop = CHAT.indexOf("if (askedQuestion) break;");
    expect(persist).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(persist);
  });
});
