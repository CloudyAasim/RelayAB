/**
 * tests/unit/assistant-transcript-render.test.ts
 *
 * "一部分内容先出来，刷新后才出来" — an answer that streams in complete and
 * then quietly loses its tail, with a refresh bringing it back.
 *
 * It reads as the server stopping early. It is not: the server sent
 * everything and wrote it to the database. Three independent reads of the same
 * thread start during one turn, and without a sequence guard the one issued
 * *first* can land *last* and replace a good transcript with a copy from before
 * the last reply was written. A refresh is just a later read, which is why it
 * looked like the fix.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { latestRead } from "@/lib/assistant/latest-read";

const CHAT = readFileSync(
  join(process.cwd(), "src", "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

describe("a read that has been overtaken", () => {
  it("is discarded, and a later one is kept", () => {
    const r = latestRead();
    const first = r.begin();
    const second = r.begin();
    // The first one answers last, which is the whole bug.
    expect(r.accept(first)).toBe(false);
    expect(r.accept(second)).toBe(true);
  });

  it("keeps a lone read, because nothing overtook it", () => {
    const r = latestRead();
    const only = r.begin();
    expect(r.accept(only)).toBe(true);
  });

  it("rejects every read but the last of a burst", () => {
    // What one turn actually does: the effect, the explicit reload, and the
    // setThreadId the response headers cause.
    const r = latestRead();
    const tokens = [r.begin(), r.begin(), r.begin()];
    expect(tokens.map((t) => r.accept(t))).toEqual([false, false, true]);
  });

  it("keeps counting, so a later refresh is never itself discarded", () => {
    const r = latestRead();
    r.begin();
    r.begin();
    const refresh = r.begin();
    expect(r.accept(refresh)).toBe(true);
    const another = r.begin();
    expect(r.accept(refresh)).toBe(false);
    expect(r.accept(another)).toBe(true);
  });
});

describe("the transcript actually uses it", () => {
  it("checks the token before writing to state", () => {
    // A guard that exists but is not consulted is the same as no guard.
    expect(CHAT).toContain("transcriptReadRef.current.accept(token)");
    const at = CHAT.indexOf("transcriptReadRef.current.accept(token)");
    const set = CHAT.indexOf("setMessages(json?.data?.messages ?? [])", at);
    expect(set).toBeGreaterThan(at);
  });

  it("keeps the current read and drops the overtaken one, not the other way round", () => {
    // The polarity is the whole guard, and it is one character from being
    // inverted — which would keep only the oldest answer, which looks exactly
    // like the bug this fixes.
    expect(CHAT).toContain("if (!transcriptReadRef.current.accept(token)) return;");
    expect(CHAT).not.toMatch(/if \(transcriptReadRef\.current\.accept\(token\)\) return;/);
  });

  it("claims a token before the request goes out", () => {
    // Claiming after the response would make every read look current at the
    // moment it arrives, which is the bug with the same shape.
    const at = CHAT.indexOf("transcriptReadRef.current.begin()");
    const fetchAt = CHAT.indexOf("fetch(`/api/assistant/threads/${id}`", at);
    expect(at).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(at);
  });
});

describe("the reader does not drop the tail", () => {
  it("handles whatever is left in the buffer after the stream closes", () => {
    // A frame whose terminator never arrived, read off a stream that is now
    // closed. There is no other chunk coming, so skipping it loses the end of
    // the answer with nothing on screen to say so.
    expect(CHAT).toMatch(/\n      handle\(buffer\.trim\(\)\);/);
  });

  it("parses frames through one path, so the leftover is parsed the same way", () => {
    // Two parsers is how a tail ends up handled differently from a body.
    const handle = CHAT.indexOf("const handle = (raw: string) =>");
    const loop = CHAT.indexOf("for (;;) {", handle);
    const tail = CHAT.indexOf("handle(buffer.trim());", loop);
    expect(handle).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(handle);
    expect(tail).toBeGreaterThan(loop);
  });
});
