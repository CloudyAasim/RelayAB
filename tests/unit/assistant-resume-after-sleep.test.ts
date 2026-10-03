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
    // un-focused is as likely to have had its stream throttled as a phone that
    // slept.
    expect(CHAT).toMatch(/addEventListener\("focus"/);
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
    expect(CHAT).toMatch(/removeEventListener\("visibilitychange"/);
    expect(CHAT).toMatch(/removeEventListener\("focus"/);
  });
});
