/**
 * tests/unit/assistant-approval-error-survives.test.ts
 *
 * An approval failed and the reason was on screen for about one frame.
 *
 * The chain: the administrator pressed 同意; the server claimed the action,
 * the apply threw, and the route wrote the real reason into the row with
 * `status = "failed"` *before* answering — that is deliberate, so the proposal is
 * not left looking actionable forever. The client read the message out of the
 * response and put it in state, then reloaded the queue.
 *
 * And the queue no longer contained that action. When it was the only pending
 * one, the list was empty, and the component returned its empty-state paragraph
 * *before* reaching the error banner further down. So the banner existed for the
 * duration of one `fetch` and was then unmounted by the very reload that was
 * supposed to keep the panel honest.
 *
 * Nothing about the failure was lost on the server — `result` holds the wording,
 * and for a media provider that is the complete list of what validation objected
 * to. But this panel is the only place an administrator reads it, and the panel
 * never loads a non-pending action, so `result` is written by every failed
 * approval and read by nothing.
 *
 * The banner is built once, above the early return, and rendered by both
 * branches. These assertions are about structure rather than behaviour because
 * the error lives in component state that a server-side render cannot seed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PANEL = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "PendingActions.tsx"),
  "utf-8",
);
const ROUTE = readFileSync(
  join(ROOT, "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
  "utf-8",
);
const TOOLS = readFileSync(join(ROOT, "src", "lib", "assistant", "tools.ts"), "utf-8");

describe("a failed approval stays on screen", () => {
  it("the banner is built before the empty-state return, not after it", () => {
    // The order is the whole bug. Rendered after the return, it can never appear
    // on the empty queue — which is the only queue a failed approval leaves.
    const banner = PANEL.indexOf("const errorBanner");
    const earlyReturn = PANEL.indexOf("if (actions.length === 0)");
    expect(banner, "the banner is not a named node any more").toBeGreaterThan(-1);
    expect(earlyReturn, "the empty-state return is gone").toBeGreaterThan(-1);
    expect(banner).toBeLessThan(earlyReturn);
  });

  it("and both branches render it", () => {
    // Two uses: the queue-empty return and the list itself. One use would leave
    // the message invisible in whichever case it was left out of.
    expect(PANEL.match(/\{errorBanner\}/g)?.length).toBe(2);
  });

  it("and it carries the server's wording rather than a status code", () => {
    // `HTTP 422` tells an administrator nothing they can act on. The body of a
    // media-provider failure is the list of fields validation rejected.
    expect(PANEL).toContain("setError(json?.error?.message ?? `HTTP ${res.status}`)");
  });

  it("the reload that empties the queue no longer clears the message", () => {
    // `setError(null)` belongs to the start of a decision, not to a reload.
    // Reloading on every pending change means anything else would clear it
    // within a frame of it arriving.
    expect(PANEL.match(/setError\(null\)/g)?.length).toBe(1);
  });

  it("the reason is stored where a failed apply put it", () => {
    // So the message on screen and the row in the database say the same thing.
    expect(ROUTE).toContain('setAssistantActionStatus(me.id, id, "failed", message)');
  });
});

describe("the panel only ever reads pending actions", () => {
  it("which is why the stored reason has nowhere to appear", () => {
    // Not a fix — a record of what this component does not do. The guard above
    // is about the message appearing at the moment it is needed; a failed action
    // leaving the queue is correct, and nothing here contradicts that.
    expect(PANEL).toContain("/api/assistant/actions?status=pending");
  });
});

describe("the assistant can read the reason too", () => {
  // The half of this that is worse than a flash. The assistant proposed a media
  // update, the approval failed, and `list_my_proposals` returned `status:
  // "failed"` and nothing else — so it produced three ranked guesses at the
  // cause and asked the user to paste a message the interface had already
  // discarded. The reason was in the row both times.
  it("the projection carries `result` rather than the status alone", () => {
    expect(TOOLS).toContain("result: a.result ?? null,");
  });

  it("and the tool description says to read it", () => {
    const start = TOOLS.indexOf('name: "list_my_proposals"');
    expect(start).toBeGreaterThan(-1);
    const body = TOOLS.slice(start, TOOLS.indexOf("parameters:", start));
    expect(body).toMatch(/result/);
    // "照它改，不要靠推断猜" — the alternative that was actually taken.
    expect(body).toMatch(/猜/);
  });
});