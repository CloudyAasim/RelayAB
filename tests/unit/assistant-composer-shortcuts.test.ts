/**
 * tests/unit/assistant-composer-shortcuts.test.ts
 *
 * Enter sends and Shift+Enter breaks the line — the usual mapping, and it was
 * what this composer used. It is now the other way round: Enter types a newline
 * and Shift+Enter sends.
 *
 * That swap is a fork, because a textarea's shortcut is described in three
 * places at once: the handler, the placeholder, and the line under the box. They
 * have to agree, and nothing in the type system, the compiler or a test
 * elsewhere would notice if they stopped. Getting it wrong does not fail — the
 * composer just quietly starts doing something other than what it says, which
 * is the same shape of defect as telling someone to press a button that was
 * removed, and as a percentage that does not match the numbers under it.
 *
 * So this file pins the three together. The wording is read as *values* out of
 * the dictionary rather than by scanning the source for it, so a reworded
 * translation cannot make the guard lie about which key does what.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DICTS, SUPPORTED_LOCALES } from "@/lib/i18n/dict";

const ROOT = process.cwd();
const COMPOSER = join(ROOT, "src/app/(user)/dashboard/assistant/AssistantChat.tsx");

/** Every string in the composer that tells the user what Enter does. */
const SHORTCUT_HINTS = ["assistant.composerHint", "assistant.placeholderHint"] as const;

/**
 * Stands in for the Shift+Enter mention while the text is taken apart. Plain
 * printable characters, because a NUL would make this file binary and a space
 * would collide with the spaces the hints are full of.
 */
const SENTINEL = "<<SHIFTED-ENTER>>";

/**
 * Whether a hint attaches the given words to one particular key.
 *
 * Checking that the text merely *contains* "send" and "new line" is worthless:
 * "Enter to send · Shift+Enter for a new line" contains both, so the old
 * wording passes a test written that way. What has to hold is which description
 * follows which key, so the text is cut at the two mentions and each half is
 * judged on its own words.
 */
function saysAbout(text: string, shifted: boolean, words: readonly string[]): boolean {
  // Masking the shifted mention leaves exactly one plain "Enter" to find.
  const marked = text.replace(/Shift\+Enter/g, SENTINEL);

  const at = shifted ? marked.indexOf(SENTINEL) : marked.indexOf("Enter");
  if (at < 0) return false;
  const start = at + (shifted ? SENTINEL.length : "Enter".length);

  // Stop at the other key, so neither half is judged on the other's words.
  const otherAt = shifted ? marked.indexOf("Enter", start) : marked.indexOf(SENTINEL, start);
  const segment = marked.slice(start, otherAt < 0 ? marked.length : otherAt);
  return words.some((w) => segment.toLowerCase().includes(w.toLowerCase()));
}

const SENDS = { "zh-CN": ["发送"], en: ["send"] } as const;
const BREAKS_LINE = { "zh-CN": ["换行", "新行"], en: ["new line"] } as const;

describe("the composer sends on the key it says it sends on", () => {
  it("Shift+Enter is the sending key in the handler", () => {
    const src = readFileSync(COMPOSER, "utf8");
    // The sending branch must be bound to the shift modifier…
    expect(src).toMatch(/e\.key === "Enter" && e\.shiftKey/);
    // …and the plain-Enter branch must be gone, which is the shape the old
    // mapping had. Asserting its absence is what stops this from passing
    // because some other `e.shiftKey` appears somewhere in the file.
    expect(src).not.toMatch(/e\.key === "Enter" && !e\.shiftKey/);
  });

  it("every locale attaches the sending key to Shift+Enter, not to Enter", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of SHORTCUT_HINTS) {
        const text = DICTS[locale][key];
        expect(text, `${locale} is missing ${key}`).toBeTruthy();
        expect(text, `${locale}/${key} does not mention Shift+Enter`).toContain("Shift+Enter");
        expect(
          saysAbout(text, true, SENDS[locale]),
          `${locale}/${key} does not say Shift+Enter sends: ${text}`,
        ).toBe(true);
        expect(
          saysAbout(text, false, BREAKS_LINE[locale]),
          `${locale}/${key} does not say Enter breaks the line: ${text}`,
        ).toBe(true);
      }
    }
  });

  it("the box can show the line Enter just inserted", () => {
    const src = readFileSync(COMPOSER, "utf8");
    // Enter no longer sends, so it is how a message is made longer than one
    // line. A textarea pinned to `rows={1}` with no resize would keep the new
    // line off screen and the caret on a line nobody can see. The cap is CSS
    // (`max-h-40`); the growth has to be scripted.
    expect(src).toMatch(/el\.style\.height = `\$\{el\.scrollHeight\}px`/);
    // …and resetting to auto first, or the box only ever grows.
    expect(src).toMatch(/el\.style\.height = "auto";\s*\n\s*el\.style\.height/);
  });
});
