/**
 * tests/unit/assistant-turn-budget.test.ts
 *
 * The turn loop is no longer cut off after eight rounds.
 *
 * It was, and that number was below what a real task needs: look up the model,
 * read the provider, probe the host, propose the change — four rounds before
 * the conversation has even started, and then "已达到 8 轮工具调用上限". The
 * budget went up, but the point is not the number: it is that the two ways a
 * loop actually goes wrong are now caught on their own terms.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  callSignature,
  repeatedCall,
  MAX_IDENTICAL_CALLS,
  MAX_TURN_MS,
} from "@/lib/assistant/chat";

const CHAT = readFileSync(join(process.cwd(), "src", "lib", "assistant", "chat.ts"), "utf-8");

describe("assistant: a turn is not eight rounds long", () => {
  it("does not stop at eight", () => {
    // The cap the user actually hit, asserted directly so nobody re-lands on it.
    expect(CHAT).not.toContain("已达到 ${MAX_ROUNDS} 轮工具调用上限");
    expect(CHAT).not.toMatch(/MAX_ROUNDS = 8\b/);
    const cap = Number(CHAT.match(/const MAX_ROUNDS = (\d+)/)?.[1]);
    expect(cap).toBeGreaterThanOrEqual(20);
  });

  it("keeps a ceiling, because an unbounded loop is a hung request", () => {
    // A ceiling the reader is told about, not a silent one.
    expect(MAX_TURN_MS).toBeGreaterThan(0);
    expect(CHAT).toContain("stopReason");
  });

  it("checks the clock, and not only the round count", () => {
    // A model that makes a *different* call every round never trips the repeat
    // detector, and forty rounds of a slow upstream is a request that hangs
    // open until something upstream gives up. The deadline is the only thing
    // that catches it.
    expect(CHAT).toMatch(/Date\.now\(\) - startedAt > MAX_TURN_MS/);
    expect(CHAT).toMatch(/MAX_TURN_MS \/ 60000/);
  });

  it("names MAX_ROUNDS in the message, so the reader can see the ceiling", () => {
    expect(CHAT).toMatch(/这一轮用完了 \$\{MAX_ROUNDS\} 次模型往返/);
  });
});

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

  it("stops on four of the same, and not on three", () => {
    // Two or three in a row is normal: read a provider, act on what you read,
    // check the result. Four is a model that is not learning anything.
    expect(repeatedCall(["a(1)", "a(1)", "a(1)"])).toBeNull();
    expect(repeatedCall(["a(1)", "a(1)", "a(1)", "a(1)"])).toBe("a(1)");
  });

  it("the threshold is the one the guard exports", () => {
    // So a change to the loop guard cannot leave the test asserting a number the
    // code no longer uses.
    expect(MAX_IDENTICAL_CALLS).toBe(4);
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

  it("says which tool was stuck, so the reader can act on it", () => {
    expect(CHAT).toContain("toolNameOf(stuck)");
    // The message names the loop rather than blaming a budget.
    expect(CHAT).toMatch(/连续 \$\{MAX_IDENTICAL_CALLS\} 次调用了同一个工具/);
  });

  it("checks progress after the round's results are in", () => {
    // A model that repeats itself usually does so once *after* seeing an answer
    // it did not like. Stopping before the result would cut off the exact case
    // where reading it would have fixed things.
    const push = CHAT.indexOf("signatures.push(");
    const check = CHAT.indexOf("repeatedCall(signatures)");
    expect(push).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(push);
  });
});
