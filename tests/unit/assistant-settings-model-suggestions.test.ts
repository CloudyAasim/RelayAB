/**
 * tests/unit/assistant-settings-model-suggestions.test.ts
 *
 * The assistant settings panel had a model field and a button that fetched the
 * list, and it threw the list away.
 *
 * `测试连通` calls `/api/assistant/settings`, which probes the upstream and
 * returns its models. The panel used them to fill the field with the first one
 * — and only when the field was empty — and kept nothing else. A vendor
 * serving twelve models gave the operator one choice out of twelve and no way
 * to see the rest, which is why the only way to set anything but the first was
 * to type it blind.
 *
 * The field is a text field with a datalist, not a select. That is the
 * opposite of the testers, which look the chosen value up in their list to get
 * a capability and an endpoint: here the id is sent as typed to an upstream the
 * operator chose, so an id this deployment has never seen is a legitimate
 * value and closing the field would make it unreachable.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PANEL = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx"),
  "utf-8",
);

const COMBOBOX = readFileSync(
  join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "ModelCombobox.tsx"),
  "utf-8",
);

describe("the assistant's model field suggests what the upstream serves", () => {
  it("keeps a text field", () => {
    expect(PANEL).toMatch(/<ModelCombobox/);
    // The load-bearing detail: the list is a popover, not a closed picker, so
    // the value is never required to be one of its options. Anchored on the JSX
    // tag rather than the word, because the file's comment discusses the other
    // shapes by name.
    expect(COMBOBOX).toMatch(/<Input/);
    expect(COMBOBOX).not.toMatch(/<select[\s/>]/);
    expect(COMBOBOX).not.toMatch(/<datalist[\s>]/);
    expect(COMBOBOX).toMatch(/onChange=\{\(e\) => onChange\(e\.target\.value\)\}/);
  });

  it("looks like the other fields, because it is built from the same parts", () => {
    // Why the native `<datalist>` went: the browser draws that popup, so it
    // does not follow the theme and it is sized by the OS. A control that looks
    // foreign beside the address and key above it is one nobody trusts.
    expect(COMBOBOX).toMatch(/import \{ Input \} from "@\/components\/ui\/Input"/);
    expect(COMBOBOX).toMatch(/import \{ Popover, PopoverAnchor, PopoverContent \}/);
    expect(COMBOBOX).toMatch(/<PopoverAnchor asChild>/);
    expect(COMBOBOX).toMatch(/<PopoverContent/);
    // An anchor, not a trigger: a trigger would put the field inside a
    // `role="button"` and take focus from it.
    expect(COMBOBOX).not.toMatch(/<PopoverTrigger/);
    // `--popover`, the radius and the shadow come from the Popover component
    // rather than from here, so the assertion is that it is used — not that a
    // class name appears in this file.
    const popover = readFileSync(join(ROOT, "src", "components", "ui", "Popover.tsx"), "utf-8");
    expect(popover, "Popover does not carry the app's own tokens").toMatch(/bg-popover/);
  });

  it("is usable without the mouse", () => {
    // Enter sends the message, so with the list open it has to pick instead —
    // otherwise an option that is visible cannot be chosen.
    expect(COMBOBOX).toMatch(/e\.key === "Enter" && open/);
    expect(COMBOBOX).toMatch(/ArrowDown/);
    expect(COMBOBOX).toMatch(/Escape/);
    expect(COMBOBOX).toMatch(/role="combobox"/);
    expect(COMBOBOX).toMatch(/role="listbox"/);
  });

  it("filters, and keeps the typed value visible when nothing matches", () => {
    // A field that disagrees with the list under it is worse than no list.
    expect(COMBOBOX).toMatch(/toLowerCase\(\)\.includes\(q\)/);
    expect(COMBOBOX).toMatch(/hits\.length > 0 \? hits : \[value,/);
  });

  it("offers exactly what the probe reported", () => {
    expect(PANEL).toMatch(/const \[knownModels, setKnownModels\] = useState<string\[\]>\(suggestedModels\)/);
    expect(PANEL).toMatch(/setKnownModels\(probe\.models\)/);
    expect(PANEL).toMatch(/options=\{knownModels\}/);
  });

  it("still fills the first model when the field is empty", () => {
    // The convenience that already worked, kept: paste URL and key, click the
    // button, and there is something to send.
    expect(PANEL).toMatch(/if \(probe\.ok && probe\.models\.length > 0\)[\s\S]{0,200}if \(!model\.trim\(\)\) setModel\(probe\.models\[0\]\)/);
  });

  it("is not empty before anything is probed", () => {
    // The suggestions were fed only by `测试连通`, which needs the key
    // retyped. On a fresh visit the list was empty, and an empty list is
    // indistinguishable from no dropdown having been built. The page passes
    // this deployment's own chat models, and the probe replaces them.
    expect(PANEL).toMatch(/suggestedModels\?: string\[\]/);
    expect(PANEL).toMatch(/useState<string\[\]>\(suggestedModels\)/);

    const page = readFileSync(
      join(ROOT, "src", "app", "(user)", "dashboard", "assistant", "page.tsx"),
      "utf-8",
    );
    expect(page).toMatch(/cachedBuildModelCatalog\(\)/);
    expect(page).toMatch(/suggestedModels=\{suggestedModels\}/);
    expect(page).toMatch(/filter\(\(m\) => m\.kind === "chat"\)/);
  });

  it("and it says where the suggestions come from", () => {
    // A dropdown with no explanation looks like the field is only allowed to
    // hold what it lists, which is the opposite of the truth here.
    expect(PANEL).toMatch(/assistant\.settings\.modelHint"/);
    expect(PANEL).toMatch(/assistant\.settings\.modelHintProbed/);
  });
});
