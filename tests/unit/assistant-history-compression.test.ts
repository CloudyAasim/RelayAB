/**
 * tests/unit/assistant-history-compression.test.ts
 *
 * The dropped half used to be dropped. Which means a long conversation did not
 * degrade — it stopped, and the model reasoned over a transcript that began
 * halfway through as though the earlier part had never happened.
 *
 * These pin the three decisions that keep it cheap and safe, because each is a
 * trade rather than a free win.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHAT = readFileSync(join(process.cwd(), "src", "lib", "assistant", "chat.ts"), "utf-8");
const fn = (name: string): string => {
  const at = CHAT.indexOf(`function ${name}`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  return CHAT.slice(at, at + 4000);
};

describe("the part that no longer fits", () => {
  it("is summarised, and the summary is what the model sees first", () => {
    // Not discarded, and not merely counted: a summary the reader cannot see is
    // a summary the model cannot reason over.
    expect(CHAT).toMatch(/async function summariseDropped\(/);
    expect(CHAT, "the summary is never put in front").toMatch(
      /role: "system" as const, content: SUMMARY_HEADER \+ summary/,
    );
    // It says what it is, so the model does not read it as a system
    // instruction from the user.
    expect(CHAT).toContain("以下是这次对话较早部分的摘要");
  });

  it("is not summarised for a conversation that has not overflowed", () => {
    // The cost is one model call, so it is spent on real overflow only — and
    // "real" is measured on what was actually cut, not on how old the thread is.
    const body = fn("summariseDropped");
    expect(body).toMatch(/if \(transcript\.length < SUMMARY_MIN_CHARS\) return null;/);
    expect(CHAT).toMatch(/const SUMMARY_MIN_CHARS = \d[\d_]*;/);
    // And the call is made only when something was dropped at all.
    expect(CHAT).toMatch(/dropped\.length > 0\s*\n?\s*\?\s*await summariseDropped/);
  });

  it("is delivered as a system message, so it cannot unpair a tool call", () => {
    // A summary placed as a tool result would sit between a call and its
    // answer — the one thing the window's boundary walk-back exists to prevent.
    const at = CHAT.indexOf("const messages: ChatMessage[]");
    expect(at).toBeGreaterThan(-1);
    const array = CHAT.slice(at, at + 600);
    expect(array).toMatch(/role: "system" as const/);
    expect(array, "the summary is not a tool message").not.toMatch(/role: "tool"/);
  });

  it("and a failed summary never stops a turn that used to work", () => {
    // The one rule that matters most: compression is a nicety, and a nicety is
    // not allowed to be a new way for a conversation to break.
    const body = fn("summariseDropped");
    expect(body, "a failing summary propagates").toMatch(
      /catch \{[\s\S]{0,200}?return null;/,
    );
    // Which is why the summary is optional in the array rather than required.
    expect(CHAT).toMatch(/\.\.\.\(summary \? \[\{ role: "system"/);
  });

  it("and the window itself is unchanged: whole messages, never half a tool call", () => {
    // Compression is additive. If this moves, the drop is no longer the only
    // thing standing between a long thread and an upstream 400.
    const fit = fn("fitToWindow");
    expect(fit).toMatch(/while \(first < kept\.length && kept\[first\]\.role === "tool"\) first \+= 1;/);
    expect(fit, "a history message is truncated by content").not.toMatch(
      /content:\s*[^,\n]*\.slice\(/,
    );
    expect(fit, "the newest turn can be dropped").toContain(
      "if (kept.length === 0 && recent.length > 0)",
    );
  });
});
