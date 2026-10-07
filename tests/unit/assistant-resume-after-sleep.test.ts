/**
 * tests/unit/assistant-resume-after-sleep.test.ts
 *
 * A locked screen left the assistant looking like it had stopped answering.
 *
 * The turn is one long-lived fetch. A phone that has been asleep, or a tab the
 * OS decided to freeze, can end that connection without the page ever seeing an
 * abort — the socket goes and no error event arrives. The server finishes the
 * turn and stores it; the screen keeps the partial answer it froze on, and the
 * send button stays disabled because this page still believes a turn is in
 * flight. Nothing else ever replaces either, so the conversation reads as
 * finished mid-sentence with no way to continue.
 *
 * The fix is to stop trusting the wire once it can no longer be trusted: on
 * returning to the foreground with a turn in flight, ask the server what the
 * transcript actually is.
 *
 * The catch is that "returning to the foreground" has to mean it. The first
 * version of this recovery ran on every window `focus` event, which fires
 * whenever the user clicks back into the window — while `visibilityState` is
 * still "visible", so the guard let it through and it aborted a turn that was
 * streaming perfectly well. `fetch` then rejects with an AbortError, which the
 * turn's own handler swallows, so the answer froze mid-sentence with nothing
 * on screen explaining why. It looked exactly like the bug this was written to
 * fix, and it happened on every alt-tab. A browser throttles the timers in a
 * hidden tab, not its open connections; losing focus costs a visible page
 * nothing. So the recovery is gated on having actually been hidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHAT = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

describe("coming back from a locked screen", () => {
  it("takes the transcript from the server, not from the frozen stream", () => {
    expect(CHAT).toMatch(/visibilitychange/);
    expect(CHAT).toMatch(/document\.visibilityState !== "visible"/);
    // Both the event and the focus, because a desktop tab that is merely
    // un-focused is how a frozen stream announces itself when the browser has
    // no visibility transition to report. Neither is sufficient on its own —
    // see the hidden-state gate below.
    expect(CHAT).toMatch(/addEventListener\("focus"/);
  });

  it("and only after the page was actually in the background", () => {
    // Recovering aborts a turn that may be perfectly healthy. `focus` alone
    // fires on every click back into the window while the page is still
    // visible, so without this gate the recovery eats live turns.
    expect(CHAT).toMatch(/if \(!wasHiddenRef\.current\) return;/);
    expect(CHAT).toMatch(/visibilityState === "hidden"\) wasHiddenRef\.current = true;/);
    // And the gate has to be spent, or one hidden state would license every
    // later focus event for the rest of the session.
    expect(CHAT).toMatch(/wasHiddenRef\.current = false;/);
  });

  it("and only when there is a turn to recover", () => {
    // Reloading on every foreground would discard an answer the user is reading
    // and fight the streaming render for no reason.
    expect(CHAT).toMatch(/if \(!busy \|\| !threadId\) return;/);
  });

  it("it stops believing it is busy, or the button stays disabled forever", () => {
    expect(CHAT).toMatch(/abortRef\.current\?\.abort\(\)/);
    expect(CHAT).toMatch(/setBusy\(false\);[\s\S]{0,80}void loadThread\(threadId\)/);
  });

  it("and it cleans the listener up", () => {
    // The effect depends on `busy`, so it re-subscribes on every state change;
    // without the cleanup that is a listener per turn.
    expect(CHAT).toMatch(/removeEventListener\("visibilitychange", onHidden\)/);
    expect(CHAT).toMatch(/removeEventListener\("visibilitychange", onVisible\)/);
    expect(CHAT).toMatch(/removeEventListener\("focus", onVisible\)/);
  });
});
