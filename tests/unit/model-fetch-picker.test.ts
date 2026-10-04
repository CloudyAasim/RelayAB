/**
 * tests/unit/model-fetch-picker.test.ts
 *
 * "Fetch models" asked, then answered for you.
 *
 * Both call sites — the create form and the edit modal — took everything the
 * upstream returned and appended it. A vendor with sixty models put sixty rows
 * into the form, sixty more on a second fetch, and the only way back was
 * deleting them one at a time. Fetching a list and materialising it are two
 * different decisions and only the first was ever asked.
 *
 * These are source-shaped because the thing being pinned is a *flow between two
 * files*: what the fetch handler does with the list it received. Rendering the
 * picker is covered by the panel's own render test; what is checked here is
 * that neither call site can go back to appending on its own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const ACTIONS = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");
const CREATE = read("src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx");
const PICKER = read("src", "app", "(admin)", "admin", "providers", "ModelPickerModal.tsx");

const CALL_SITES = [
  ["the edit modal", ACTIONS],
  ["the create form", CREATE],
] as const;

describe("a fetch hands the list to the operator", () => {
  it("neither call site appends on its own any more", () => {
    for (const [name, src] of CALL_SITES) {
      // The line that made the decision for them, gone from both.
      expect(src, `${name} still merges the whole fetch`).not.toMatch(
        /setModelRows\(\(prev\) =>\s*mergeFetchedModels\(prev, data\.models/,
      );
      // …and the merge now happens inside the picker's confirm handler, on the
      // subset the operator ticked.
      expect(src, `${name} does not open the picker`).toMatch(
        /setPickerOpen\(true\)/,
      );
      expect(src, `${name} does not collect what the fetch found`).toMatch(
        /setFetchedEntries\(\(data\.models \?\? \[\]\) as PickedEntry\[\]\)/,
      );
      expect(src, `${name} mounts the picker`).toContain("<ModelPickerModal");
      expect(src, `${name} adds only what was chosen`).toMatch(
        // A window wide enough for the comment each site puts above its merge:
        // a guard that stops matching the day somebody explains the line is a
        // guard that gets deleted rather than fixed.
        /onConfirm=\{\(chosen\) =>[\s\S]{0,400}?mergeFetchedModels\(prev, chosen/,
      );
    }
  });

  it("the picker offers every fetched model, and what the vendor said about it", () => {
    expect(PICKER, "the context window is not shown").toContain("contextLength");
    expect(PICKER, "the output cap is not shown").toContain("maxOutputTokens");
    expect(PICKER, "the thinking levels are not shown").toContain("reasoningLevels");
    expect(PICKER, "there is no way to tick them all").toMatch(/selectAllFetched/);
    // Nothing is added until the button is pressed.
    expect(PICKER, "confirming needs a button, not a render").toMatch(
      /<Button disabled=\{chosen\.length === 0\} onClick=\{\(\) => onConfirm\(chosen\)\}/,
    );
  });

  it("a model already in the list is shown and cannot be added twice", () => {
    // Hidden rather than absent: a row missing from the list is a row somebody
    // fetches again, and again, and wonders why it keeps coming back.
    expect(PICKER, "existing models are not shown").toMatch(/already\.has\(e\.id\)/);
    expect(PICKER, "an existing model can still be ticked").toMatch(/disabled=\{done\}/);
    expect(PICKER).toContain("admin.providers.alreadyAdded");
  });
});
