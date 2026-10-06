/**
 * tests/unit/media-tester-default-voice.test.ts
 *
 * Two places pre-fill a voice, because MiniMax's `t2a_v2` rejects a request with
 * no `voice_setting.voice_id` — the field is optional in the spec precisely so
 * the failure only shows up at runtime, as a bare 400 phrased as "missing
 * required parameter".
 *
 * That makes both pre-filled values load-bearing, and they had drifted: the media
 * test page moved to a Mandarin voice while the assistant's own media tool kept
 * the English one. Nothing caught it, because each value was only reachable from
 * its own module and no test compared them.
 *
 * So the assertion is the agreement, not the value. Naming one voice here would
 * be the same pin-instead-of-rule mistake the other test files have already been
 * rewritten for: the two can be made to agree by editing one, or made to
 * disagree by editing the other, and only a comparison catches the second.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const TESTER = read("src", "app", "(user)", "dashboard", "models", "MediaTester.tsx");
const TOOLS = read("src", "lib", "assistant", "tools.ts");

/** The `const DEFAULT_TTS_VOICE = "…";` line, wherever it lives. */
function defaultVoice(source: string): string {
  const m = source.match(/const DEFAULT_TTS_VOICE = "([^"]+)";/);
  if (!m) throw new Error("no DEFAULT_TTS_VOICE in this source");
  return m[1];
}

describe("the two pre-filled voices", () => {
  it("are the same voice", () => {
    // A reader who sets one up and the other not gets an assistant that speaks
    // one language on the test page and another in the assistant, and nothing on
    // either surface says so.
    expect(defaultVoice(TOOLS)).toBe(defaultVoice(TESTER));
  });

  it("and it is one MiniMax actually documents", () => {
    // `female-shaonv` is the 少女音色 in MiniMax's T2A v2 system voice list. A
    // typo is another runtime 400 from the page whose whole job is to report
    // whether a credential works, and it would read as a credential problem
    // rather than a typo.
    const voice = defaultVoice(TESTER);
    expect(voice).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(voice).toBe("female-shaonv");
  });

  it("and each one is still the default, not something the caller must supply", () => {
    // The reason the constants exist at all. If either call site stopped using
    // its own, the value would remain declared and asserted forever.
    for (const source of [TESTER, TOOLS]) {
      const uses = source.match(/DEFAULT_TTS_VOICE/g) ?? [];
      expect(uses.length).toBeGreaterThan(1);
    }
  });
});
