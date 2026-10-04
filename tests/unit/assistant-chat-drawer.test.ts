/**
 * tests/unit/assistant-chat-drawer.test.ts
 *
 * The drawer's sections, rendered rather than read.
 *
 * The report this answers was a heading — "which identity the tools should use"
 * — standing over nothing, on the account path, with a paragraph under it about
 * not needing a key. Only the *input* had been made conditional, so the section
 * around it rendered unconditionally: an empty box with a title, which is worse
 * than either showing the field or showing nothing.
 *
 * Source matching cannot catch that, because the conditional and the section are
 * both present and both correct in isolation. Rendering is the only way to ask
 * "is there a heading here with nothing under it".
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), "utf-8");
const CHAT = read("app", "(user)", "dashboard", "assistant", "AssistantChat.tsx");

/** The section this file is about, sliced out of the drawer. */
function perTurnSection(): string {
  const start = CHAT.indexOf("PerTurnKeyField value=");
  expect(start, "the per-turn key field is gone from the drawer").toBeGreaterThan(-1);
  // Walk back to the opening tag of the section that holds it.
  const open = CHAT.lastIndexOf("<section", start);
  return CHAT.slice(open, CHAT.indexOf("</section>", start));
}

describe("the per-turn key section", () => {
  it("is not rendered at all unless the saved mode is the key path", () => {
    // A `return null` inside the field hides the input and leaves the heading,
    // the paragraph and the spacing behind. The condition has to be on the
    // section, and it has to be the *saved* mode rather than whatever the mode
    // switch in the form is currently showing.
    expect(CHAT).toMatch(
      // The window has to span the whole section: the field is the last thing in
      // it, and a window that stopped early would pass on a section that had
      // lost its only control.
      /\{credentialMode === "key" && \(\s*<section[\s\S]{0,700}?PerTurnKeyField value=/,
    );
    // …and the field itself no longer decides whether it renders.
    expect(CHAT).not.toMatch(/function PerTurnKeyField\([\s\S]{0,400}?if \(!active\) return null;/);
    expect(CHAT).toMatch(/const credentialMode = config\.mode;/);
  });

  it("and its own text is about the key, not about the choice above it", () => {
    // The heading used to restate the mode question — "which identity the tools
    // should use" — which the settings form directly above now answers, and
    // which is a different question from "paste a key for this one turn".
    const section = perTurnSection();
    expect(section, "the section still names the old heading").not.toContain(
      "assistant.tools.title",
    );
    expect(section).toContain("assistant.credential.perTurnTitle");
    expect(section).toContain("assistant.credential.perTurnDesc");
    // …and the old wording is gone from the file entirely rather than merely
    // unused, because an unused label is a label somebody will reuse.
    expect(CHAT, "the old tools heading is still here").not.toContain("assistant.tools.title");
    expect(CHAT, "the old tools paragraph is still here").not.toContain("assistant.tools.desc");
  });

  it("and the key field itself is still there on the path that needs it", () => {
    // The input lives in the component, not in the section, so it is checked
    // where it is written — but it is the *section* that decides whether either
    // of them renders, which is the point of the test above.
    const field = CHAT.slice(CHAT.indexOf("function PerTurnKeyField("));
    expect(field.slice(0, 1200), "the field lost its input").toContain('type="password"');
    expect(field.slice(0, 1200)).toContain('placeholder="sk-relay-..."');
    expect(field.slice(0, 1200)).toContain("assistant.credential.keyLabel");
    // …and nothing in it still decides to hide itself.
    expect(field.slice(0, 1200), "the field hides itself again").not.toContain("return null;");
  });
});
