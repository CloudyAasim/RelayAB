/**
 * tests/unit/assistant-settings-model-suggestions.test.ts
 *
 * The model field: a picker shaped exactly like every other picker on the page,
 * with a way to type something it does not list.
 *
 * Three shapes came before this one, and the reasons they went are the point of
 * this file, because each of them looked reasonable:
 *
 *  - A closed `<select>`: it *is* the other pickers, and it cannot hold a model
 *    this deployment has never heard of. The value is sent as typed to an
 *    upstream the operator chose, so such a model is legitimate.
 *  - A native suggestion list: the browser draws that popup, so it ignored the
 *    theme and was sized by the OS — a control that looked foreign beside the
 *    address and key above it.
 *  - A popover over a text field: it matched the theme, and it threw on render,
 *    because its anchor was a sibling of the popover root rather than a child.
 *    That one took the whole page down, and `next build` plus every unit test
 *    passed, because nothing here renders this component.
 *
 * What is left is the real picker, the same class list, and one extra entry.
 * Nothing to position, nothing to portal, nothing to throw.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");
const COMBOBOX = read("src", "app", "(user)", "dashboard", "assistant", "ModelCombobox.tsx");
const PAGE = read("src", "app", "(user)", "dashboard", "assistant", "page.tsx");

describe("the model field is one of the pickers, plus a way to type your own", () => {
  it("the settings panel uses it", () => {
    expect(PANEL).toMatch(/<ModelCombobox/);
    expect(PANEL).toMatch(/options=\{knownModels\}/);
    expect(PANEL).toMatch(/onChange=\{setModel\}/);
  });

  it("is the same element as the others, with the same class list", () => {
    expect(COMBOBOX).toMatch(/<select[\s\S]{0,240}id=\{id\}/);
    // The identical string the model page's pickers use. Matching it is the
    // whole requirement; approximating it is what failed.
    expect(COMBOBOX).toContain("h-9 w-full rounded-md border border-input bg-background px-3 text-sm");
    // And nothing that can be positioned wrong, portal, or throw on render.
    expect(COMBOBOX).not.toMatch(/Popover/);
  });

  it("the custom entry reveals a field, because a closed list cannot hold it", () => {
    expect(COMBOBOX).toMatch(/const CUSTOM = "__custom__"/);
    expect(COMBOBOX).toMatch(/<option value=\{CUSTOM\}>/);
    expect(COMBOBOX).toMatch(/\{custom && \(\s*<Input/);
    // Typing in the revealed field is what the value ends up as.
    expect(COMBOBOX).toMatch(/onChange=\{\(e\) => onChange\(e\.target\.value\)\}/);
  });

  it("a value that is not on the list starts in custom mode", () => {
    // Otherwise the picker shows nothing selected for the model the operator
    // typed, which reads as the field having forgotten it.
    expect(COMBOBOX).toMatch(/useState\(\(\) => !value \|\| !known\.includes\(value\)\)/);
  });

  it("every option it offers is one the list actually has", () => {
    expect(COMBOBOX).toMatch(/\[\.\.\.new Set\(options\.map\(\(o\) => o\.trim\(\)\)\.filter\(Boolean\)\)\]/);
  });
});

describe("the list it offers", () => {
  it("is never empty before anything is probed", () => {
    // It was fed only by `测试连通`, which needs the key retyped. On a fresh
    // visit there was nothing to choose from, which is indistinguishable from
    // no dropdown having been built. The page passes this deployment's own chat
    // models, and the probe replaces them with its own answer.
    expect(PANEL).toMatch(/suggestedModels\?: string\[\]/);
    expect(PANEL).toMatch(/useState<string\[\]>\(suggestedModels\)/);
    expect(PAGE).toMatch(/cachedBuildModelCatalog\(\)/);
    expect(PAGE).toMatch(/suggestedModels=\{suggestedModels\}/);
    expect(PAGE).toMatch(/filter\(\(m\) => m\.kind === "chat"\)/);
  });

  it("is exactly what the probe reported, once it has run", () => {
    expect(PANEL).toMatch(/setKnownModels\(probe\.models\)/);
    expect(PANEL).toMatch(
      /if \(probe\.ok && probe\.models\.length > 0\)[\s\S]{0,200}if \(!model\.trim\(\)\) setModel\(probe\.models\[0\]\)/,
    );
    // Filling the first one is a convenience; overwriting what the operator
    // typed is losing their work.
    expect(PANEL).not.toMatch(/\}\s*setModel\(probe\.models\[0\]\)/);
  });

  it("and it says where the options came from", () => {
    // A picker with no explanation reads as a constraint rather than a hint.
    expect(PANEL).toMatch(/assistant\.settings\.modelHint"/);
    expect(PANEL).toMatch(/assistant\.settings\.modelHintProbed/);
  });
});
