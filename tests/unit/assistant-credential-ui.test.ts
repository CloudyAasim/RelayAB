/**
 * tests/unit/assistant-credential-ui.test.ts
 *
 * The credential panel replaced a key field that used to sit at the top of both
 * testers, and two things went wrong that only a person looking at the screen
 * would have caught:
 *
 *   1. the old key fields stayed, so each card showed two of them and the
 *      account path silently ignored the top one;
 *   2. the page opened on "use my account" while that option was disabled -
 *      for anyone who had not created a credential - and because the key field
 *      is hidden while it is selected, the page looked like it had no way to
 *      run a test at all.
 *
 * These are source-level guards on purpose. The behaviour lives in a client
 * component whose state machine is only exercised by a real click, and the
 * defect was "a field that should not be there", which is exactly the kind of
 * thing a test has to name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf-8");

const CHAT_TESTER = read("app/(user)/dashboard/models/ModelTester.tsx");
const MEDIA_TESTER = read("app/(user)/dashboard/models/MediaTester.tsx");
const PANEL = read("lib/assistant/CredentialPanel.tsx");

describe("credential UI: one key field, owned by the panel", () => {
  it("neither tester keeps its own key input", () => {
    for (const [name, source] of [
      ["ModelTester", CHAT_TESTER],
      ["MediaTester", MEDIA_TESTER],
    ] as const) {
      // A password input bound to relayKey is the old duplicate. The panel's
      // own field lives in CredentialPanel.tsx and is not in this list.
      expect(source, `${name} still renders its own key field`).not.toMatch(
        /type="password"[\s\S]{0,400}value=\{relayKey\}/,
      );
    }
  });

  it("both testers route the key through the panel", () => {
    for (const [name, source] of [
      ["ModelTester", CHAT_TESTER],
      ["MediaTester", MEDIA_TESTER],
    ] as const) {
      expect(source, `${name} does not mount CredentialPanel`).toContain("<CredentialPanel");
    }
  });

  it("the media tester can actually spend the account credential", () => {
    // Mounting the panel is not enough: without the account branch a user who
    // switched it on would still be told to paste a key.
    expect(MEDIA_TESTER).toContain("/api/assistant/test-media");
    expect(MEDIA_TESTER).toMatch(/credentialMode === "account"/);
  });

  it("says out loud that transcription stays on the key path", () => {
    // The account route speaks JSON and recognition uploads a file, so that
    // capability cannot use it. Silently falling back to a hidden key would be
    // the same class of bug as the two duplicate fields.
    expect(MEDIA_TESTER).toContain("accountBlockedReason");
    expect(MEDIA_TESTER).toContain("isStt ?");
  });
});

describe("credential UI: the page never rests on an unusable option", () => {
  it("falls back to the key path when the account path is unavailable", () => {
    expect(PANEL).toMatch(/if \(!canUseAccount && mode === "account" && !userPickedRef\.current\)/);
  });

  it("leaves a deliberate choice alone", () => {
    // Auto-correcting a selection the user actually made would be worse than
    // the bug it fixes.
    expect(PANEL).toContain("userPickedRef");
    expect(PANEL).toContain("const choose = useCallback");
  });

  it("takes the selection to the account path once a credential is switched on", () => {
    expect(PANEL).toMatch(/if \(action === "enable"\) choose\("account"\)/);
  });

  it("shows the key field only while the key path is selected", () => {
    expect(PANEL).toMatch(/\{mode === "key" && \(/);
  });
});

describe("credential UI: the testers' spacing", () => {
  it("the media run button and its reasons are not on one line", () => {
    // Two hints and a button used to sit shoulder to shoulder in a flex row,
    // reading as a single run-on line.
    expect(MEDIA_TESTER).not.toMatch(
      /<div className="flex items-center gap-2">\s*<Button onClick=\{run\}/,
    );
  });

  it("the file picker is boxed like every other field", () => {
    expect(MEDIA_TESTER).toMatch(/type="file"[\s\S]{0,400}border border-input/);
  });

  it("a lone field in a two-column grid spans the row", () => {
    expect(MEDIA_TESTER).toContain("sm:col-span-2");
  });
});
