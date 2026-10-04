/**
 * tests/unit/provider-mode-sticks.test.ts
 *
 * The mode could not be left.
 *
 * `load()` re-derives the mode from the row, and the row's mode is "advanced"
 * whenever it carries a rule. The edit modal called it from an effect keyed on
 * the `provider` *object* — which comes back from JSON, so any re-render that
 * re-fetches it produces a new identity and the effect runs again. Clicking
 * "simple" set the state, and the next unrelated render put it straight back.
 *
 * A display choice the operator made half a second ago should not be reverted by
 * a render they did not ask for. The effect is keyed on the row's id — the thing
 * that actually identifies a different row — so it re-reads when the modal opens
 * or when a different provider is loaded, and not otherwise.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MODAL = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx"),
  "utf-8",
);
const HOOK = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "providers", "form", "use-provider-form.ts"),
  "utf-8",
);
const SWITCH = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "providers", "ProviderModeSwitch.tsx"),
  "utf-8",
);

describe("the chosen mode survives a render the operator did not ask for", () => {
  it("the reload effect is keyed on the row's id, not the row's identity", () => {
    expect(MODAL).toMatch(/\}, \[open, provider\.id, load\]\)/);
    // Anchored on the dependency array rather than the word: the effect body
    // has to keep receiving the whole object, or it would load a stale row.
    expect(MODAL).not.toMatch(/\}, \[open, provider, load\]\)/);
  });

  it("it still reloads when the modal opens and when a different row is loaded", () => {
    expect(MODAL).toMatch(/if \(open\) load\(provider\);/);
  });

  it("and the mode is the operator's, not a function of the row, while editing", () => {
    // `load` deriving the mode is right *once*, when the row is read. After
    // that the state belongs to whoever is editing.
    expect(HOOK).toMatch(/setMode\(modeForProvider\(provider\)\)/);
    // And the switch writes it directly rather than asking the row again.
    expect(SWITCH).toMatch(/onClick=\{\(\) => onChange\(id\)\}/);
  });
});
