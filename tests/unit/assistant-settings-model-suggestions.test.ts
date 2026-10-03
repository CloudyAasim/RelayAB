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

describe("the assistant's model field suggests what the upstream serves", () => {
  it("keeps a text field", () => {
    expect(PANEL).toMatch(/<Input[\s\S]{0,300}id="assistant-model"/);
    // The load-bearing detail: the suggestion list is a datalist, so the value
    // is never required to be one of its options.
    expect(PANEL).toMatch(/list="assistant-model-options"/);
    expect(PANEL).toMatch(/<datalist id="assistant-model-options">/);
  });

  it("offers exactly what the probe reported", () => {
    expect(PANEL).toMatch(/const \[knownModels, setKnownModels\] = useState<string\[\]>\(\[\]\)/);
    expect(PANEL).toMatch(/setKnownModels\(probe\.models\)/);
    expect(PANEL).toMatch(/knownModels\.map\(\(m\) => \(\s*<option key=\{m\} value=\{m\} \/>/);
  });

  it("still fills the first model when the field is empty", () => {
    // The convenience that already worked, kept: paste URL and key, click the
    // button, and there is something to send.
    expect(PANEL).toMatch(/if \(probe\.ok && probe\.models\.length > 0\)[\s\S]{0,200}if \(!model\.trim\(\)\) setModel\(probe\.models\[0\]\)/);
  });

  it("does not overwrite a model the operator already typed", () => {
    // The `!model.trim()` guard asserted above is the whole behaviour, and it is
    // the one most likely to be broken by a future edit — it is the difference
    // between "convenience" and "loses what you typed".
    expect(PANEL).toMatch(/!model\.trim\(\)\)\s*setModel/);
    expect(PANEL).not.toMatch(/\}\s*setModel\(probe\.models\[0\]\)/);
  });
});
