/**
 * tests/unit/assistant-mic-permission.test.ts
 *
 * Ask, then wait. Do not diagnose.
 *
 * Three versions of this button, in order:
 *
 *  1. asked only when pressed, and reported every failure as "allow it in the
 *     browser";
 *  2. asked on mount, and asked the Permissions API what the browser thought
 *     in order to split "refused" from "blocked" — which told an operator who
 *     had just set the microphone to Allow that the browser had remembered a
 *     refusal. They were looking at the setting that disproved it;
 *  3. this one. Raise the request, and if nobody answers it, say so.
 *
 * The reason 2 was wrong is structural, not a slip: `getUserMedia` does not
 * settle until the prompt is answered, so while it is outstanding there is
 * nothing to diagnose. And a conclusion about what the browser will remember
 * cannot be verified from here — only disproved, by an operator who knows what
 * they just did in the settings.
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

describe("it asks, then it waits", () => {
  it("raises the request on mount", () => {
    expect(MIC).toMatch(/useEffect\(\(\) => \{[\s\S]{0,200}ask\(\);/);
    expect(MIC).toMatch(/navigator\.mediaDevices[\s\S]{0,80}getUserMedia\(\{ audio: true \}\)/);
    // Nothing is recorded and nothing is kept: the tracks go the moment they
    // arrive. A microphone the operator cannot see is worse than none.
    expect(MIC).toMatch(/stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  });

  it("says something only after waiting, and then only about what to do", () => {
    expect(MIC).toMatch(/const ASK_TIMEOUT_MS = \d+_?\d*/);
    expect(MIC).toMatch(/setTimeout\(\(\) => setState\("waiting"\), ASK_TIMEOUT_MS\)/);
    // A later answer clears the wait rather than leaving a stale complaint.
    expect(MIC).toMatch(/\.then\(\(stream\) => \{[\s\S]{0,120}clearTimer\(\)/);
    expect(MIC).toMatch(/\.catch\(\(err\) => \{[\s\S]{0,80}clearTimer\(\)/);
  });

  it("pressing the button asks again immediately", () => {
    expect(MIC).toMatch(/await navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/);
    // The press path re-raises the request even when it just failed, because
    // pressing it is an explicit ask and a transient cause — a device another
    // program was holding a moment ago — is the cheapest thing to rule out.
    expect(MIC).toMatch(/const reason = explainFailure\(err, t\);[\s\S]{0,400}ask\(\);/);
  });
});

describe("it says why, and says the browser's reason when it has none of ours", () => {
  it("both paths use one explanation", () => {
    /**
     * The mount path classified failures and the press path answered "press it
     * again" to all of them — so a machine with no microphone in it was told to
     * try again, which is advice for a different case. Two paths into one
     * `getUserMedia` had become two different vocabularies, again.
     */
    const uses = MIC.match(/explainFailure\(/g) ?? [];
    expect(uses.length, "explainFailure is defined and used").toBeGreaterThanOrEqual(3);
    expect(MIC).not.toMatch(/assistant\.voice\.askAgain/);
  });

  it("covers the failures the browser names that are not about permission", () => {
    // A device that is missing, and a device another program is holding, look
    // identical from the page if it only reports "no microphone".
    expect(MIC).toMatch(/NotReadableError/);
    expect(MIC).toMatch(/NotFoundError/);
    expect(MIC).toMatch(/NotAllowedError/);
    expect(MIC).toMatch(/AbortError/);
  });

  it("passes an unrecognised failure through instead of guessing", () => {
    // Everything this file's earlier versions got wrong ended here: a confident
    // sentence that could not be checked. The raw name and message can be.
    expect(MIC).toMatch(/assistant\.voice\.unknown", \{ detail:/);
    expect(DICT).toMatch(/assistant\.voice\.unknown/);
  });
});

describe("it makes no claim it cannot check", () => {
  it("does not ask the browser what it remembers", () => {
    // The whole of version 2. It was the source of a wrong answer, not a
    // missing one.
    //
    // Anchored on the type, not on the bare word: the header comment above
    // names the state this version removed, and a substring search reports the
    // explanation as the defect. (Fourth time today, for a source assertion
    // matching the sentence about the bug.)
    expect(MIC).not.toMatch(/type MicState = [^;]*"blocked"/);
    expect(MIC).not.toMatch(/navigator\.permissions/);
    expect(MIC).not.toMatch(/lastChanged/);
  });

  it("and has exactly one message about the microphone being unavailable", () => {
    // One sentence, one remedy. "The browser has remembered a refusal" is a
    // claim about the future that nobody here can verify.
    expect(MIC).toMatch(/assistant\.voice\.waitingHint/);
    expect(DICT).not.toMatch(/已被浏览器记住|remembered a refusal/);
    expect(DICT).not.toMatch(/不会.{0,6}再弹窗|will not ask again/);
  });

  it("but still names the two failures the browser does name", () => {
    // A missing device and a missing answer are different problems, and both
    // are things the operator can act on.
    expect(MIC).toMatch(/NotFoundError/);
    expect(MIC).toMatch(/recordingSupported\(\)/);
    expect(MIC).toMatch(/window\.isSecureContext !== false/);
  });
});

describe("each string exists in both languages", () => {
  it.each([
    "start",
    "stop",
    "working",
    "asking",
    "waiting",
    "waitingHint",
    "refused",
    "busy",
    "aborted",
    "unknown",
    "failed",
    "empty",
    "noDevice",
    "unsupportedContext",
  ])("assistant.voice.%s", (key) => {
      // A key present in one locale and missing in the other renders as the
      // raw key string in the interface.
      const hits = DICT.match(new RegExp(`"assistant\\.voice\\.${key}":`, "g")) ?? [];
      expect(hits.length, key).toBe(2);
    },
  );

  it("the waiting message points at the prompt, not at a diagnosis", () => {
    expect(DICT).toMatch(/地址栏/);
    expect(DICT).toMatch(/address bar/);
  });
});
