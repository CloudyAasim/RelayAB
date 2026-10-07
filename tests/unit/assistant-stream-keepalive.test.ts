/**
 * tests/unit/assistant-stream-keepalive.test.ts
 *
 * A long assistant turn was being cut from the outside, with nothing on screen
 * saying so.
 *
 * The application's own ceilings are generous — 400 rounds, 30 identical calls
 * in a row, 30 minutes — and the code even says so: the loop guard "was never
 * the thing stopping a long turn". The thing stopping it was a proxy in front of
 * the app. nginx's `proxy_read_timeout` measures the gap *between* reads, so a
 * turn that is streaming is safe, but a slow model call or a long tool call can
 * go minutes without emitting a byte, and that gap is what gets the connection
 * closed. Nothing in the app decided to stop; the answer just stops arriving.
 *
 * Two halves, and the second is the one that keeps the promise:
 *
 *  1. A keep-alive comment frame, so the socket is never silent long enough to
 *     be timed out. It has to be a *comment*: the client drops anything that is
 *     not a `data:` line, so a visible event here would be noise on screen.
 *  2. If the body still ends without the turn saying it finished, the reader is
 *     told the connection dropped. Otherwise "the connection dropped" and "the
 *     assistant gave up" look identical, and only one of them is true.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ROUTE = "src/app/api/assistant/chat/route.ts";
const CLIENT = "src/app/(user)/dashboard/assistant/AssistantChat.tsx";

describe("a silent turn keeps the connection alive", () => {
  it("emits a keep-alive the client will ignore, and stops it on close", () => {
    const src = read(ROUTE);
    // A comment line, not a `data:` frame — the client drops the latter into
    // JSON.parse and would show a parse error every 25 seconds.
    expect(src).toMatch(/enqueue\(encoder\.encode\(": keep-alive\\n\\n"\)\)/);
    // An interval that is never cleared keeps the process alive after the turn.
    expect(src).toMatch(/clearInterval\(keepAlive\)/);
    // And it must be created before the awaits it is meant to cover.
    expect(src.indexOf("setInterval")).toBeLessThan(src.indexOf("await runChat("));
  });

  it("the client drops anything that is not a data frame", () => {
    // This is what makes the keep-alive free. If a parser ever starts handling
    // other line types, the keep-alive becomes user-visible noise.
    expect(read(CLIENT)).toMatch(/if \(!raw\.startsWith\("data:"\)\) return;/);
  });

  it("and says so when the turn never finished", () => {
    const src = read(CLIENT);
    // Set on the event itself, not on `pendingActions` — a finished turn with
    // nothing pending still finished.
    expect(src).toMatch(/evt\.type === "done"\) \{\s*sawDone = true;/);
    // ...but a turn that reported its own error also ends without finishing,
    // and this used to overwrite that error with the generic one. "Upstream
    // returned 504" and "the connection dropped" are not the same claim, and
    // only the first one is true when the turn failed. The generic message is
    // for turns that ended without saying anything at all.
    expect(src).toMatch(/evt\.type === "error" && evt\.text\) \{\s*sawError = true;/);
    expect(src).toMatch(/if \(!sawDone && !sawError\) \{\s*setError\(/);
  });

  it("and the interruption message exists in both languages", async () => {
    const { DICTS, SUPPORTED_LOCALES } = await import("@/lib/i18n/dict");
    for (const locale of SUPPORTED_LOCALES) {
      expect(DICTS[locale]["assistant.streamInterrupted"], locale).toBeTruthy();
    }
  });
});
