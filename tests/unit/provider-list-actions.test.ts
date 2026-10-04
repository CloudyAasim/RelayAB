/**
 * tests/unit/provider-list-actions.test.ts
 *
 * The list row had a "fetch models" button that was not a duplicate of the one
 * in the edit modal. It was a second path with a different body: it PATCHed
 * `modelMapping` with every id the vendor returned and reloaded the page. No
 * form, no confirmation, no undo — so a vendor that serves sixty models rewrote
 * the mapping of a provider somebody had just finished configuring, and the only
 * way back was to type it out again.
 *
 * That is why the button is gone rather than fixed. There is nothing to configure
 * there: the models are a field of the provider, and the place to edit a field is
 * the form, which is one click away and asks before it changes anything.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const ACTIONS = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");

/** The row of icon buttons, sliced out of the table cell. */
function listActions(): string {
  const at = ACTIONS.indexOf('onClick={runTest}');
  expect(at, "the list actions are gone entirely").toBeGreaterThan(-1);
  return ACTIONS.slice(ACTIONS.lastIndexOf("<div", at), ACTIONS.indexOf("</div>", at));
}

describe("the provider list row", () => {
  it("offers test, edit and delete — and nothing that writes", () => {
    const row = listActions();
    expect(row, "test connection went away").toContain("onClick={runTest}");
    expect(row, "edit went away").toContain("onClick={openEdit}");
    expect(row, "delete went away").toContain("onClick={remove}");
    // The one that PATCHed the mapping from outside the form.
    expect(row, "the list still fetches models").not.toContain("fetchModels");
  });

  it("and the handler that wrote the mapping is gone with it", () => {
    // Not merely unrendered: a handler that writes a provider's mapping is the
    // dangerous part, and leaving it wired to nothing is how it comes back.
    expect(ACTIONS, "the list-level fetch handler survived").not.toMatch(
      /async function fetchModels\(/,
    );
    // It was the only caller of this helper, which re-read the mapping to
    // append to it — the append that was the problem.
    expect(ACTIONS, "the append helper survived").not.toContain("fetchCurrentModelMapping");
  });

  it("while the edit modal keeps the capability, and asks first", () => {
    // Removed from the row, not from the product: the same job is still one
    // click away, inside the form, and it opens the picker before anything is
    // added. Asserted over the whole file because the handler and the button
    // that renders it are not adjacent — slicing between them proved nothing.
    expect(ACTIONS, "the edit modal lost the fetch").toContain("admin.providers.fetchModels");
    expect(ACTIONS, "the modal no longer opens the picker").toContain("setPickerOpen(true)");
    expect(ACTIONS, "the modal no longer collects what the fetch found").toContain(
      "setFetchedEntries(",
    );
    // The append that was the problem: a mapping written from outside the form.
    expect(ACTIONS, "something still PATCHes a mapping from a fetch").not.toMatch(
      /method: "PATCH"[\s\S]{0,160}modelMapping: merged/,
    );
  });
});
