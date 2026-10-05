/**
 * The badge and the list are two copies of one number, and they were refreshed
 * at different times.
 *
 * The chat holds the count for the badge and refreshed it when a turn created a
 * proposal. The panel holds the list and read it on mount and after its own
 * approve or reject, and at no other time. `router.refresh()` does not bridge
 * them — it re-renders the server components and leaves a client component's
 * state where it was. So sending a message that proposed three changes moved
 * the badge to 3 while the list under it still said none, which reads as a
 * queue that is empty rather than one that has not been read.
 *
 * Returning to a background tab had the same shape, with neither side
 * refreshing: the chat only reloaded the transcript while a turn was in flight,
 * and the panel was not listening at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING_CHANGED } from "@/lib/assistant/pending-bus";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const CHAT = read("src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");
const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "PendingActions.tsx");
const BUS = read("src", "lib", "assistant", "pending-bus.ts");

describe("the queue is announced, not assumed", () => {
  it("both holders of the number subscribe", () => {
    // One without the other is the original bug with half the fix applied.
    expect(CHAT).toMatch(/onPendingChanged\(/);
    expect(PANEL).toMatch(/onPendingChanged\(/);
  });

  it("a turn that creates proposals tells both", () => {
    // The refresh is gated on the turn having produced something, which is right
    // for its own copy and was the reason the other one went stale.
    //
    // A wide window on purpose: the point is that both calls sit inside the
    // `done` branch, and a narrow slice that stops a line short would pass
    // against a version that refreshed the badge and nothing else.
    const at = CHAT.indexOf('evt.type === "done"');
    const done = CHAT.slice(at, at + 800);
    expect(done).toContain("loadPendingCount");
    expect(done).toContain("announcePendingChanged");
  });

  it("resolving a proposal tells both too", () => {
    // The other direction. Approving here used to refresh only this list, and
    // the badge went on saying the queue was full.
    expect(PANEL).toMatch(/await load\(\);[\s\S]{0,200}announcePendingChanged\(\);/);
  });

  it("and returning to the tab refreshes both", () => {
    // The likeliest way for this page to be wrong is to have been in a
    // background tab while the queue changed somewhere else.
    expect(BUS).toContain("visibilitychange");
    expect(BUS).toContain("focus");
  });
});

describe("the bus itself", () => {
  it("is safe to call outside a browser", () => {
    // A module imported by a server component must not throw at import time.
    expect(BUS).toMatch(/if \(typeof window === "undefined"\) return/);
  });

  it("returns an unsubscribe, so a re-render cannot leak a listener", () => {
    expect(BUS).toContain("removeEventListener");
  });

  it("namespaced, so it cannot collide with anything else on the page", () => {
    expect(PENDING_CHANGED).toMatch(/^relayab:/);
  });
});
