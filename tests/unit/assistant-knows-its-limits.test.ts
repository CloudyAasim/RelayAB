/**
 * tests/unit/assistant-knows-its-limits.test.ts
 *
 * The assistant told a user the gateway has a "300 s serverless ceiling" and that
 * a 4K generation might "hit the timeout". Both statements were true once and had
 * been false since 2026-10-01; the model had no way to know, because the only
 * places that described the limit still said 300 s (the spec validator and the
 * protocol document), and its own tool layer still cut media calls at 240 s.
 *
 * Knowledge and behaviour are both pinned here:
 *
 *   - what the assistant is told (prompts, deployment notes) must describe the
 *     limit that exists — the spec's own `limits.timeoutMs` plus the turn clock;
 *   - what its tools do must not add a smaller one of their own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const ZH = read("src", "lib", "assistant", "prompts.ts");
const EN = read("src", "lib", "assistant", "prompts.en.ts");
const NOTES = read("src", "lib", "assistant", "deployment-notes.ts");
const TOOLS = read("src", "lib", "assistant", "tools.ts");
const CHAT = read("src", "lib", "assistant", "chat.ts");

describe("what the assistant is told about time", () => {
  it("both languages point at the spec's deadline and the heartbeat", () => {
    for (const [name, text] of [
      ["zh", ZH],
      ["en", EN],
    ] as const) {
      expect(text, name).toContain("limits.timeoutMs");
      expect(text, name).toMatch(/心跳|heartbeat/);
    }
  });

  it("both languages explicitly disown the 300 s / serverless story", () => {
    // The words may appear only as something to *deny*; the surrounding sentence
    // is what matters, so the check is that the denial exists at all.
    expect(ZH).toContain("300 秒上限");
    expect(ZH).toMatch(/不要告诉用户|不成立/);
    expect(EN).toContain('300 second cap');
    expect(EN).toMatch(/do not tell the user|has been|true since/);
  });

  it("the deployment notes explain how a long media call survives the proxy", () => {
    expect(NOTES).toMatch(/心跳/);
    expect(NOTES).toContain("3500000");
    // And they say idle time, not total time, is what nginx measures — the
    // distinction that makes the advice correct.
    expect(NOTES).toMatch(/空闲/);
  });
});

describe("what the assistant's tools actually do", () => {
  it("no media tool invents a 240 s deadline any more", () => {
    expect(TOOLS).not.toMatch(/AbortSignal\.timeout\(240_000\)/);
  });

  it("media tools are bounded by the turn's own clock", () => {
    expect(TOOLS).toContain("function mediaCallSignal");
    expect(TOOLS).toMatch(/ctx\.turnDeadlineAt/);
    // And the turn hands that clock down.
    expect(CHAT).toContain("turnDeadlineAt: turnStartedAt + MAX_TURN_MS");
  });
});
