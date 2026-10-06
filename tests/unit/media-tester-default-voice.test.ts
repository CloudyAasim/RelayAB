/**
 * tests/unit/media-tester-default-voice.test.ts
 *
 * The media test page pre-fills a voice because MiniMax's `t2a_v2` rejects a
 * request with no `voice_setting.voice_id`, and that rejection is a bare 400
 * phrased as "missing required parameter" — the field is optional in the spec
 * precisely so the failure only shows up at runtime.
 *
 * That makes the pre-filled value load-bearing, and it is now a Mandarin voice.
 * Nothing else guards it: the assistant's own media tool has its own default,
 * and the delivery tests pass a voice explicitly, so all three would have kept
 * passing with the old value restored.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const TESTER = read("src", "app", "(user)", "dashboard", "models", "MediaTester.tsx");

describe("the media test page's pre-filled voice", () => {
  it("is a real MiniMax system voice, and not the English one it replaced", () => {
    // `female-shaonv` is the documented 少女音色 in MiniMax's own T2A v2 voice
    // list. A typo here is another runtime 400 from a page whose whole job is to
    // tell you whether the credential works.
    expect(TESTER).toContain('const DEFAULT_TTS_VOICE = "female-shaonv";');
    expect(TESTER).not.toContain("English_Trustworth_Man");
  });

  it("is still the default rather than something the form has to ask for", () => {
    // The point of the constant is that a request goes out with a voice when the
    // user has not picked one.
    expect(TESTER).toMatch(/DEFAULT_TTS_VOICE/);
    const uses = TESTER.match(/DEFAULT_TTS_VOICE/g) ?? [];
    expect(uses.length).toBeGreaterThan(1);
  });
});
