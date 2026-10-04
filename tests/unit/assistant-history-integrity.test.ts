/**
 * tests/unit/assistant-history-integrity.test.ts
 *
 * The history the model receives, called and checked.
 *
 * It used to drop both halves of every tool exchange — the `tool` rows, and the
 * `assistant` rows that made the calls — to avoid sending a `tool_call` with no
 * result. A conversation replayed that way reads as though the model only ever
 * talked: it cannot see what it looked up, what it found, or that it had found
 * it. That is the context loss, and it was total for every tool the assistant
 * ran.
 *
 * Two rules now hold, and both are protocol rules rather than preferences:
 * a call travels with its result, and a result never travels without its call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHAT = readFileSync(join(ROOT, "src", "lib", "assistant", "chat.ts"), "utf-8");

const fn = (name: string): string => {
  const at = CHAT.indexOf(`function ${name}`);
  expect(at, `${name} is gone`).toBeGreaterThan(-1);
  return CHAT.slice(at, at + 4000);
};

describe("the history a turn is given", () => {
  it("carries the tool turns instead of discarding them", () => {
    const body = fn("toWireMessages");
    // The old shape, which is what made the model blind to its own work.
    expect(body, "tool rows are still dropped wholesale").not.toMatch(
      /if \(row\.role === "tool"\) continue;/,
    );
    expect(body, "assistant tool-call turns are still dropped").not.toMatch(
      /if \(row\.role === "assistant" && row\.toolCalls\.length > 0\) \{\s*\n\s*\/\/ Skip/,
    );
    expect(body, "the call is not sent with its name and arguments").toContain(
      "tool_calls: row.toolCalls.map",
    );
    expect(body, "the result is not sent with the id it answers").toContain(
      "tool_call_id: row.toolCallId",
    );
  });

  it("repairs the pairing instead of avoiding it", () => {
    const body = fn("toWireMessages");
    // A result whose call is missing, and a call whose result is missing, are
    // both refused — separately, because they fail in opposite directions.
    expect(body, "a result without its call survives").toMatch(
      /if \(m\.role === "tool"\) return Boolean\(m\.tool_call_id\) && called\.has/,
    );
    expect(body, "a call without its result survives").toMatch(
      /if \(m\.tool_calls && m\.tool_calls\.length > 0\) return m\.tool_calls\.every/,
    );
  });

  it("never starts the kept window on a tool result", () => {
    const fit = fn("fitToWindow");
    // A tool message is an answer; replayed without the question it answers, the
    // upstream rejects the turn — and the window is cut from the front, so this
    // is where it happens.
    expect(fit, "the window may start mid-exchange").toMatch(
      /while \(first < kept\.length && kept\[first\]\.role === "tool"\) first \+= 1;/,
    );
    expect(fit).toMatch(/return first > 0 \? kept\.slice\(first\) : kept;/);
  });

  it("and still drops whole messages rather than cutting one in half", () => {
    // The other half of that rule: a tool result is all-or-nothing, and so is
    // every other message. A message rewritten to fit is a message the model
    // then reasons about as if it were complete.
    const fit = fn("fitToWindow");
    expect(fit, "a history message is truncated by content").not.toMatch(
      /content:\s*[^,\n]*\.slice\(/,
    );
    expect(fit, "the newest turn can be dropped").toContain(
      "if (kept.length === 0 && recent.length > 0)",
    );
  });
});
