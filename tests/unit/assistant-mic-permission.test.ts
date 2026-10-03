/**
 * tests/unit/assistant-mic-permission.test.ts
 *
 * A microphone the site never asked for.
 *
 * The first version called `getUserMedia` only when the button was pressed. A
 * prompt raised by pressing a button is easy to refuse by reflex, and the
 * refusal is remembered for the site: the next visit does not prompt at all,
 * and the button reports "allow it in the browser" — advice that cannot work,
 * because the browser will not ask again. Only the Permissions API can tell
 * the two apart, so the two states get different words and different remedies.
 *
 * Asking on mount is the other half. The assistant screen is where the
 * microphone is visible and its purpose obvious, so the prompt lands somewhere
 * it can be answered on purpose rather than dismissed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIC = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "MicButton.tsx"),
  "utf-8",
);
const DICT = readFileSync(join(ROOT, "src", "lib", "i18n", "dict.ts"), "utf-8");

describe("the microphone is asked for up front", () => {
  it("requests on mount, not only on the first click", () => {
    expect(MIC).toMatch(/useEffect\(\(\) => \{[\s\S]{0,2000}getUserMedia\(\{ audio: true \}\)/);
    // And the tracks are released immediately: this is a permission check, not
    // a recording. An open microphone the operator cannot see is worse than
    // none.
    expect(MIC).toMatch(/stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  });

  it("keeps the press-to-record path working", () => {
    expect(MIC).toMatch(/onClick=\{phase === "recording" \? stop : start\}/);
    expect(MIC).toMatch(/recorder\.start\(\)/);
  });
});

describe("a refusal and a block are told apart", () => {
  it("asks the browser what it thinks the state is", () => {
    expect(MIC).toMatch(/navigator\.permissions[\s\S]{0,200}query\(\{ name: "microphone"/);
    expect(MIC).toMatch(/status\.onchange/);
  });

  it("a block takes two refusals, not one", () => {
    /**
     * The bug this file was corrected by.
     *
     * "Blocked" is a claim about the *future*: that the browser will not ask
     * again. It was being asserted from a single `getUserMedia` rejection plus a
     * permissions query that said "denied" — and an operator who had just set
     * the microphone to Allow was told, to their face, that the browser had
     * remembered a refusal. They were looking at the settings that disproved it.
     *
     * Two refusals make it a fact. One makes it a guess.
     */
    expect(MIC).toMatch(
      /state === "denied"[\s\S]{0,400}await navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/,
    );
    expect(MIC).toMatch(/setPermission\("blocked"\)/);
    // And the neutral message survives for everything short of a confirmed
    // block, rather than escalating to a claim that can be checked and found
    // wrong.
    expect(MIC).toMatch(/assistant\.voice\.denied/);
    expect(MIC).toMatch(/assistant\.voice\.stillFailing/);
  });

  it("recognises a page loaded before the setting was changed", () => {
    // Granting the microphone in site settings does not retroactively fix a
    // page that already failed to open it, and "reload" is the actual remedy.
    // The old messages only ever said reload as part of the blocked remedy,
    // which is precisely the case where it was not the problem.
    expect(MIC).toMatch(/lastChanged/);
    expect(MIC).toMatch(/changedJustNow/);
  });

  it("reads the error name the way browsers actually set it", () => {
    // `instanceof DOMException` is unreliable across realms; the `name` is.
    expect(MIC).toMatch(/"name" in err \? String\(\(err as Error\)\.name\)/);
    expect(MIC).not.toMatch(/err instanceof DOMException \? err\.name/);
  });

  it("a blocked button says so before it is pressed", () => {
    expect(MIC).toMatch(/const blocked = permission === "blocked"/);
    expect(MIC).toMatch(/assistant\.voice\.blockedHint/);
  });

  it("says which failure it was", () => {
    // A missing device, a refused permission and an insecure page are three
    // different problems with three different fixes.
    expect(MIC).toMatch(/NotFoundError/);
    expect(MIC).toMatch(/NotAllowedError/);
    expect(MIC).toMatch(/recordingSupported\(\)/);
    expect(MIC).toMatch(/window\.isSecureContext !== false/);
  });
});

describe("each remedy exists in both languages", () => {
  it.each([
    "blocked",
    "blockedHint",
    "denied",
    "noDevice",
    "unsupportedContext",
    "changedJustNow",
    "stillFailing",
  ])("assistant.voice.%s", (key) => {
    // A key present in one locale and missing in the other renders as the raw
    // key string in the interface.
    const hits = DICT.match(new RegExp(`"assistant\\.voice\\.${key}":`, "g")) ?? [];
    expect(hits.length, key).toBe(2);
  });

  it("the blocked message names the place the fix lives", () => {
    // "Allow it in the browser" is not actionable. The site-settings icon is.
    expect(DICT).toMatch(/地址栏/);
    expect(DICT).toMatch(/address bar/);
  });
});
