/**
 * One ceiling, not five stacked under it.
 *
 * The symptom was an answer that stopped part-way through a sentence with no
 * message, and asking again started the model thinking from the top only to be
 * cut off at the same place. Continuing could not finish the work, because
 * continuing was the thing being cut off.
 *
 * The cause was a two-minute timeout on every individual model call, sitting
 * underneath a turn that was allowed half an hour. Nothing in the interface said
 * the turn had thirty minutes and no single step of it had two; the two numbers
 * contradicted each other and the smaller one won, silently, mid-stream.
 *
 * So a call now inherits what is left of the turn. The turn ceiling is unchanged
 * and is the only one the reader is told about; the guards below it exist to stop
 * a model going nowhere, not to stop a model working.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callSignature,
  MAX_HISTORY_MESSAGES,
  MAX_IDENTICAL_CALLS,
  MAX_ROUNDS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TURN_MS,
  repeatedCall,
} from "@/lib/assistant/chat";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const CHAT = read("src", "lib", "assistant", "chat.ts");
const CLIENT = read("src", "lib", "assistant", "client.ts");

describe("assistant: what a stuck model looks like", () => {
  it("calls two things with the same arguments the same call", () => {
    expect(callSignature("list_providers", "{}")).toBe(callSignature("list_providers", "{}"));
    expect(callSignature("list_providers", "{}")).not.toBe(callSignature("list_users", "{}"));
  });

  it("does not care what order the JSON keys arrived in", () => {
    // A model that re-emits {a,b} as {b,a} has not learned anything. Counting
    // that as progress is exactly how a stuck loop runs for forty rounds.
    expect(callSignature("propose", '{"a":1,"b":{"c":2,"d":3}}')).toBe(
      callSignature("propose", '{"b":{"d":3,"c":2},"a":1}'),
    );
  });

  it("still tells two different calls apart when one field differs", () => {
    expect(callSignature("test", '{"model":"a"}')).not.toBe(callSignature("test", '{"model":"b"}'));
    // Array order is meaning, not formatting.
    expect(callSignature("t", '{"m":["a","b"]}')).not.toBe(callSignature("t", '{"m":["b","a"]}'));
  });

  it("compares unparseable arguments as written", () => {
    // The only honest thing to do with a truncated tool call.
    expect(callSignature("t", "{oops")).toBe(callSignature("t", "{oops"));
    expect(callSignature("t", "{oops")).not.toBe(callSignature("t", "{fine"));
  });

  it("does not stop on a handful of repeats, because real work repeats", () => {
    // Re-reading a configuration after each write, or a page after each edit, is
    // what a long job looks like. At four the guard was telling a model that was
    // doing the right thing that it was stuck.
    expect(repeatedCall(["a(1)", "a(1)", "a(1)", "a(1)"])).toBeNull();
  });

  it("the threshold is the one the guard exports", () => {
    // So a change to the loop guard cannot leave the test asserting a number the
    // code no longer uses. The threshold is asserted against the constant rather
    // than a number, so retuning it does not leave this test asserting a value
    // the code no longer uses — which is how it came to disagree with the loop
    // guard in the first place.
    expect(MAX_IDENTICAL_CALLS).toBeGreaterThanOrEqual(20);
    expect(repeatedCall(new Array(MAX_IDENTICAL_CALLS).fill("a(1)"))).toBe("a(1)");
  });

  it("needs the whole tail to match, not just part of it", () => {
    // Three calls that include two identical ones is a model making progress.
    const sigs = ["list(1)", "list(1)", "propose(2)"];
    expect(repeatedCall(sigs)).toBeNull();
  });

  it("is not fooled by a different tool repeating", () => {
    const sigs = ["a()", "b()", "a()", "b()", "a()"];
    expect(repeatedCall(sigs)).toBeNull();
  });

  it("honours an explicit threshold, and will take another below it", () => {
    // The exported constant is the one callers use; this checks the parameter
    // still works, which is what the ceiling above is actually for.
    expect(repeatedCall(["x()", "x()"], 2)).toBe("x()");
    expect(repeatedCall(["x()", "x()"], 3)).toBeNull();
  });

  it("the turn is bounded by the clock and nothing else", () => {
    // There used to be three ceilings and two of them counted. Both counters
    // reported a model that was doing exactly the right thing as stuck: a
    // configuration job re-reads the same provider after every write, a
    // documentation job re-reads the same page after every edit, and both were
    // told they had made no progress. `repeatedCall` survives as a helper — it is
    // a reasonable thing to test — but the loop must not consult it, and there
    // must be no round ceiling to hit at all.
    expect(CHAT).not.toMatch(/repeatedCall\(signatures\)/);
    expect(CHAT).not.toMatch(/< MAX_ROUNDS/);
    expect(CHAT).not.toContain("用完了");
    // The one that is left.
    expect(CHAT).toMatch(/Date\.now\(\) - startedAt > MAX_TURN_MS/);
  });
});

describe("a call inherits the turn's ceiling instead of a smaller one", () => {
  it("and the turn hands down what is left of its budget", () => {
    // Without this the call falls back to whatever the client defaults to, and
    // the two numbers drift apart again the moment a limit is retuned.
    expect(CHAT).toMatch(/const remaining = \(\) => MAX_TURN_MS - \(Date\.now\(\) - startedAt\)/);
    expect(CHAT).toMatch(/timeoutMs: Math\.max\(remaining\(\), 60_000\)/);
  });

  it("there is no default deadline on a call that was not given one", () => {
    // The line that caused it. A two-minute floor under a thirty-minute ceiling
    // meant a long job could not be completed by continuing, because every
    // continuation met the same two minutes.
    expect(CLIENT).not.toMatch(/opts\.timeoutMs \?\? 120_000/);
    expect(CLIENT).toMatch(
      /opts\.timeoutMs !== undefined[\s\S]{0,120}setTimeout\(\(\) => controller\.abort\(\), opts\.timeoutMs\)/,
    );
  });

  it("a probe still answers quickly, because it is a different job", () => {
    // It is a reachability check with a user waiting on a button, not a turn.
    // Fifteen seconds is the right ceiling for that and must not be swept up
    // with the change above.
    expect(CLIENT).toMatch(/opts\.timeoutMs \?\? 15_000/);
  });

  it("the turn ceiling is still thirty minutes", () => {
    expect(MAX_TURN_MS).toBe(30 * 60 * 1000);
    expect(CHAT).toMatch(/Date\.now\(\) - startedAt > MAX_TURN_MS/);
  });
});

describe("the guards behind it do not stop work", () => {
  it("the two that counted are gone; the two that trim are still generous", () => {
    // `MAX_ROUNDS` and `MAX_IDENTICAL_CALLS` counted, and both fired on real
    // work. They are kept as exported constants only so the loop cannot be given
    // a ceiling back by accident; the loop does not read either.
    expect(MAX_ROUNDS).toBeGreaterThanOrEqual(200);
    expect(MAX_IDENTICAL_CALLS).toBeGreaterThanOrEqual(20);
    // What remains only bounds a single payload, never the turn.
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThanOrEqual(200_000);
    expect(MAX_HISTORY_MESSAGES).toBeGreaterThanOrEqual(100);
  });

  it("and the ones that stay say so in the message the reader gets", () => {
    // A turn that ends on the clock has to say which clock, or it reads as the
    // assistant giving up.
    expect(CHAT).toContain("这一轮已经跑了");
    expect(CHAT).toContain("分钟");
  });

  it("a tool result big enough to hold a vendor page is not cut", () => {
    // 60,000 was enough for most pages and not for all, and a page cut mid-sentence
    // is not a shorter page — it is a page the model then re-fetches.
    expect(MAX_TOOL_RESULT_CHARS).toBeGreaterThanOrEqual(200_000);
  });
});
