/**
 * tests/unit/upstream-deadline.test.ts
 *
 * The small piece the text proxy uses to make `limits.timeoutMs` real.
 *
 * The distinction it exists for: a chat answer is a stream, and "this provider
 * may take 120 s to start answering" must not mean "cut the answer at two
 * minutes". So the timer is cleared the moment the headers arrive.
 */
import { describe, it, expect } from "vitest";
import { upstreamDeadline } from "@/lib/http/upstream-deadline";

describe("upstreamDeadline", () => {
  it("gives no signal when the spec declared no timeout", () => {
    expect(upstreamDeadline(undefined, undefined).signal).toBeUndefined();
    expect(upstreamDeadline(undefined, 0).signal).toBeUndefined();
    expect(upstreamDeadline(undefined, -5).signal).toBeUndefined();
    expect(upstreamDeadline(undefined, Number.NaN).signal).toBeUndefined();
  });

  it("passes the caller's signal through untouched", () => {
    const controller = new AbortController();
    expect(upstreamDeadline(controller.signal, undefined).signal).toBe(controller.signal);
  });

  it("aborts after the declared time", async () => {
    const deadline = upstreamDeadline(undefined, 30);
    expect(deadline.signal).toBeDefined();
    await new Promise((resolve) => {
      deadline.signal!.addEventListener("abort", resolve, { once: true });
    });
    expect(deadline.signal!.aborted).toBe(true);
    deadline.done();
  });

  it("stops counting once the headers have arrived", async () => {
    const deadline = upstreamDeadline(undefined, 30);
    deadline.done();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Headers are in; the body is the client's clock now.
    expect(deadline.signal!.aborted).toBe(false);
  });

  it("still honours a client disconnect after the deadline is cleared", () => {
    const caller = new AbortController();
    const deadline = upstreamDeadline(caller.signal, 10_000);
    deadline.done();
    caller.abort();
    expect(deadline.signal!.aborted).toBe(true);
  });
});
