/**
 * tests/unit/assistant-turn-and-read-guards.test.ts
 *
 * Three things that used to be true at once, and each one reads as something
 * else entirely.
 *
 * **A summary call with no deadline.** `callAssistantModel` arms a timer only
 * when the caller passes `timeoutMs` (`client.ts:183`) — the streaming path has
 * no default, unlike its non-streaming sibling at `client.ts:484`. The summary
 * call passed nothing, and `MAX_TURN_MS` is checked at the bottom of the
 * *tool* loop, which this runs before. So an upstream that accepted the
 * connection and then went quiet held the turn open forever, while the
 * route's 25-second keep-alive kept the connection alive for it. It looks
 * like a model that never answers, which is exactly what the reader is told
 * when it is really a missing argument.
 *
 * **An account-mode window nobody read.** The route passes no `settings` on
 * the account path by design — `onAccount ? null : stored` — and the declared
 * window arrives in `modelParams` instead. Reading `settings?.contextLength`
 * alone meant those users fell through to the fixed 24,000-token fallback. The
 * system prompt and one turn already cost 11,937, so half the budget was gone
 * before the conversation started and every long chat was compressed early,
 * paying an extra model call each time.
 *
 * **A failed read rendered as an empty one.** `json?.data?.messages ?? []`
 * cannot tell "this thread is empty" from "the server did not answer with a
 * thread", and a gateway returning an HTML error page lands squarely in the
 * second. The transcript was rewritten to nothing, with no message saying so
 * and nothing to put it back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const CHAT = read("src/lib/assistant/chat.ts");
const CLIENT = read("src/lib/assistant/client.ts");
const ROUTE = read("src/app/api/assistant/chat/route.ts");
const PANEL = read("src/app/(user)/dashboard/assistant/AssistantChat.tsx");
const PENDING = read("src/app/(user)/dashboard/assistant/PendingActions.tsx");

describe("a summary call cannot outlive the turn", () => {
  it("passes a deadline", () => {
    // Source-level on purpose: the behaviour is a value handed to a function
    // whose timeout is set two files away, and the point is that the argument
    // is *there* rather than what a particular number is.
    const body = CHAT.slice(CHAT.indexOf("async function summariseDropped"));
    const call = body.slice(0, body.indexOf("const text = turn.content"));
    expect(call, "summariseDropped has no timeoutMs").toMatch(/timeoutMs:\s*SUMMARY_TIMEOUT_MS/);
  });

  it("names a ceiling that exists", () => {
    expect(CHAT).toMatch(/const SUMMARY_TIMEOUT_MS\s*=\s*[\d_]+/);
  });

  it("the call it makes really does arm a timer when given one", () => {
    // Otherwise the assertion above only proves that an argument was spelled.
    expect(CLIENT).toMatch(/opts\.timeoutMs\s*!==\s*undefined\s*\n?\s*\?\s*setTimeout/);
  });
});

describe("the account path's declared window is the one that gets used", () => {
  it("reads the window from the parameters too", () => {
    expect(CHAT).toMatch(/settings\?\.contextLength\s*\?\?\s*opts\.modelParams\?\.contextLength/);
  });

  it("and the account path is the one that has no settings to read", () => {
    // This is what makes the fallback above load-bearing rather than
    // redundant. If the route stopped dropping `settings` on that path, the
    // second read would be harmless — and this assertion would be the reason
    // anyone noticed it had become so.
    expect(ROUTE).toMatch(/onAccount\s*\?\s*null\s*:\s*stored/);
  });

  it("the parameters it falls back to really do carry a window", () => {
    expect(read("src/lib/assistant/config.ts")).toMatch(/contextLength:\s*row\?\.contextLength/);
  });
});

describe("a read that failed is not an empty thread", () => {
  it("checks the status before writing the transcript", () => {
    const fn = PANEL.slice(PANEL.indexOf("const loadThread = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, []);"));
    expect(body, "loadThread rewrites the transcript on a failed read").toMatch(/if \(!res\.ok/);
    // The old shape is the whole bug: a missing body and a missing thread
    // produce the same value, so one of them is unreachable.
    expect(body, "loadThread still conflates a failure with an empty thread").not.toMatch(
      /setMessages\(json\?\.data\?\.messages \?\? \[\]\)/,
    );
  });

  it("says something when it does fail", () => {
    const fn = PANEL.slice(PANEL.indexOf("const loadThread = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, []);"));
    expect(body, "a failed read must not be silent").toMatch(/setError\(/);
  });

  it("the same for the thread list", () => {
    const fn = PANEL.slice(PANEL.indexOf("const loadThreads = useCallback"));
    const body = fn.slice(0, fn.indexOf("}, []);"));
    expect(body, "loadThreads reports a failed read as no history").toMatch(/if \(!res\.ok/);
  });
});

describe("a sent attachment stops being 'already chosen'", () => {
  it("is dropped from the dedupe map when it is sent", () => {
    // Without this the same file can only ever be attached once per page
    // load: `addFiles` skips on a key match, silently, so the paperclip
    // appears to do nothing and the send button stays disabled.
    const fn = PANEL.slice(PANEL.indexOf("async function send("));
    expect(fn.slice(0, 2000), "send does not retire the files it sent").toMatch(/files\.delete\(/);
  });

  it("the dedupe it has to satisfy reads that same map", () => {
    expect(PANEL).toMatch(/if \(files\.has\(key\)/);
  });

  it("every object URL is released when the page goes away", () => {
    expect(PANEL).toMatch(/revokeObjectURL\(url\)/);
  });
});

describe("starting a new conversation retires the reads still in flight", () => {
  it("claims a sequence number before clearing", () => {
    // Matched as one run of statements rather than by position, because the
    // explanation above the code quotes `setMessages([])` — the thing being
    // checked — and an index search finds the quote first.
    expect(PANEL).toMatch(
      /transcriptReadRef\.current\.begin\(\);\s*setThreadId\(null\);\s*setMessages\(\[\]\);/,
    );
  });
});

describe("a network failure does not cost the administrator their key", () => {
  it("the catch path restores it, like the non-ok path already does", () => {
    const idx = PENDING.indexOf("} catch (err) {");
    const catchBody = PENDING.slice(idx, idx + 800);
    expect(catchBody, "a request that never arrived clears the key").toMatch(/setKeys\(/);
  });

  it("and the branch it is imitating still does", () => {
    expect(PENDING).toMatch(/setKeys\(\(prev\) => \(\{ \.\.\.prev, \[id\]: apiKey \}\)\)/);
  });
});

describe("an unrelated conversation does not inherit another's error", () => {
  it("switching threads clears the banner", () => {
    // Whatever the distance, they belong to the same handler: `th.id` only
    // appears here.
    expect(PANEL).toMatch(/setThreadId\(th\.id\);[\s\S]{0,400}setError\(null\)/);
  });
});
