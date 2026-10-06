/**
 * tests/unit/model-tester-model-picker.test.ts
 *
 * What the model pickers are allowed to be.
 *
 * They were a closed `<select>`, then briefly an `<input list>` so a model the
 * catalogue does not know could be typed by hand, then a closed `<select>`
 * again. The middle version was reverted **here**: the tester does not take a
 * model id and go, it looks the chosen value up in the list it was given and
 * uses that entry's capability and endpoint, and a typed id has no entry — so
 * it traded a closed list for an empty one.
 *
 * That is a property of the tester, not of `<input list>`. The assistant's
 * settings panel takes the other shape: its model id is sent as typed, to an
 * upstream the operator chose, so a list it has never heard of is a legitimate
 * value and closing the field would make it unreachable. That one keeps a text
 * field with a datalist over whatever the probe reported — see
 * assistant-settings-model-suggestions.test.ts.
 *
 * What the probe added is kept, because it survives a closed picker: the probe
 * can ask a vendor what it serves, and those ids now land in both lists, so a
 * model added since the catalogue was built becomes selectable instead of merely
 * visible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIGURABLE_PROTOCOLS } from "@/lib/protocol/text-protocols";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const CHAT = read("src", "app", "(user)", "dashboard", "models", "ModelTester.tsx");
const MEDIA = read("src", "app", "(user)", "dashboard", "models", "MediaTester.tsx");
const PROBE = read("src", "app", "(user)", "dashboard", "models", "CustomModelProbe.tsx");
const PAGE = read("src", "app", "(user)", "dashboard", "models", "page.tsx");
const WORKSPACE = read("src", "app", "(user)", "dashboard", "models", "ModelsWorkspace.tsx");
const PANEL = read(
  "src",
  "app",
  "(user)",
  "dashboard",
  "assistant",
  "AssistantSettingsPanel.tsx",
);
const COMBOBOX = read(
  "src",
  "app",
  "(user)",
  "dashboard",
  "assistant",
  "ModelCombobox.tsx",
);

const TESTERS = [
  ["ModelTester", CHAT],
  ["MediaTester", MEDIA],
] as const;

describe("a picker whose endpoint depends on the chosen entry is closed", () => {
  it("MediaTester looks the id up for its capability, so it stays a select", () => {
    // The reason, in the code that creates it: four capabilities, four
    // endpoints. A typed id has no capability and so nowhere to go. The old
    // guard said this about both pickers, and for one of them it was true.
    expect(MEDIA).toMatch(/models\.find\(\(m\) => m\.id === model\)/);
    expect(MEDIA).toMatch(/const capability = current\?\.capability \?\? "";/);
    expect(MEDIA).toMatch(/<select\s+id="media-model"/);
    expect(MEDIA).not.toMatch(/<datalist/);
    expect(MEDIA).toMatch(/<option key=/);
  });
});

describe("a picker that sends one fixed endpoint can still be typed", () => {
  it("ModelTester uses the same combobox the assistant settings use", () => {
    // Not a shape invented here. `ModelCombobox` is the house answer, and its
    // own comment records the three shapes that were tried and why each failed —
    // including the native `<datalist>` popup, which the browser draws and the
    // theme cannot reach. Approximating that component is how the picker came to
    // look foreign beside the key field above it.
    expect(CHAT).toMatch(/import \{ ModelCombobox \} from "\.\.\/assistant\/ModelCombobox"/);
    expect(CHAT).toMatch(/<ModelCombobox/);
    expect(CHAT).toMatch(/id="model-tester-model"/);
    expect(CHAT).toMatch(/options=\{chatModels\}/);
  });

  it("sends to one origin regardless of the id", () => {
    // What makes this the other case from MediaTester, in the code that decides
    // it. `base` is the origin and the path is fixed; nothing is looked up per
    // model, so there was never a catalogue entry to be missing.
    expect(CHAT).toMatch(/window\.location\.origin/);
    expect(CHAT).toMatch(/\/v1\/chat\/completions/);
    expect(CHAT).not.toMatch(/chatModels\.(find|indexOf|includes)/);
  });

  it("does not reintroduce a native suggestion list", () => {
    // The shape that was reverted, and the one that caused the visual mismatch.
    // The combobox reveals its text field from an option instead, so the popup
    // stays a themed `<select>`.
    expect(CHAT).not.toMatch(/<datalist/);
    expect(CHAT).not.toMatch(/\blist="[^"]*options"/);
    expect(CHAT).not.toMatch(/<input\s+id="model-tester-model"/);
  });

  it("and a refusal reads as a sentence, since that is the likely answer", () => {
    expect(CHAT).toMatch(/function readableError\(/);
    expect(CHAT).toMatch(/setError\(readableError\(res\.status, text\)\)/);
  });
});

describe("the combobox is the same control the assistant settings use", () => {
  it("both surfaces render the one component", () => {
    // Two shapes for the same field is how they drifted apart in the first
    // place; the shared component is what stops it happening again.
    expect(PANEL).toMatch(/import \{ ModelCombobox \} from "\.\/ModelCombobox"/);
    expect(PANEL).toMatch(/<ModelCombobox/);
  });

  it("and it is a real select with a way in", () => {
    // The two halves that matter: the dropdown the theme can reach, and the
    // escape hatch for a model this deployment has never heard of.
    expect(COMBOBOX).toMatch(/<select/);
    expect(COMBOBOX).toMatch(/const CUSTOM = "__custom__"/);
    expect(COMBOBOX).toMatch(/setCustom\(true\)/);
  });

  it("and a value that is not on the list starts in custom mode", () => {
    // Otherwise a hand-typed id that is already set shows as "nothing selected"
    // the moment the page renders, which is the opposite of what it is for.
    expect(COMBOBOX).toMatch(/useState\(\(\) => !value \|\| !known\.includes\(value\)\)/);
  });
});

describe("the probe's models reach the pickers", () => {
  it("it reports what it listed", () => {
    expect(PROBE).toMatch(/onFetched\?: \(models: string\[\]\) => void/);
    expect(PROBE).toMatch(/onFetched\?\.\(json\.data\.models\)/);
  });

  it("the probe's models land in those closed lists", () => {
    // Which is what the probe wiring is *for*: the picker is closed, so the
    // only way a newly listed model becomes testable is for the probe to hand
    // it to the list.
    expect(PROBE).toMatch(/onFetched\?: \(models: string\[\]\) => void/);
    expect(PROBE).toMatch(/onFetched\?\.\(json\.data\.models\)/);
    expect(WORKSPACE).toMatch(/onFetched=\{onFetched\}/);
    expect(WORKSPACE).toMatch(/\[\.\.\.new Set\(\[\.\.\.catalogChatModels, \.\.\.probed\]\)\]/);
  });

  it("the page passes the catalogue down, unprobed", () => {
    // The page is a server component; it can only supply the snapshot.
    expect(PAGE).toMatch(/catalogChatModels=\{catalogChatModels\}/);
    expect(PAGE).toMatch(/catalogMediaModels=\{catalogMediaModels\}/);
  });

  it("a probed id carries no capability rather than a wrong one", () => {
    // The catalogue does not know it yet, so there is nothing honest to label
    // it with. An empty capability renders as no badge instead of a wrong badge.
    expect(WORKSPACE).toMatch(/probed\.map\(\(id\) => \(\{ id, capability: "", provider: "" \}\)\)/);
  });
});

describe("the page holding the shared state is a client component", () => {
  it("models/page.tsx uses no hooks and no client directive", () => {
    /**
     * Found by `next build`, not by anything else.
     *
     * The probe's result has to reach the testers, so something has to hold
     * state, so `useState` went into `models/page.tsx` — which is a server
     * component. Every type checked. The whole unit suite passed. The build
     * refused it: "You're importing a component that needs `useState`." The
     * client/server boundary is not a type rule and `tsc` will never see it.
     *
     * So the state is asserted to live in the client workspace instead, and
     * the page is asserted to be free of hooks. The build remains the real
     * check; this is what makes the failure cheap next time.
     */
    expect(PAGE).not.toMatch(/^\s*"use client"/m);
    expect(PAGE).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Reducer|Transition)\b/);
    expect(PAGE).toMatch(/<ModelsWorkspace/);
  });

  it("ModelsWorkspace is the client boundary, and it owns the merge", () => {
    expect(WORKSPACE).toMatch(/^\s*"use client"/m);
    expect(WORKSPACE).toMatch(/const \[probed, setProbed\] = useState<string\[\]>\(\[\]\)/);
    expect(WORKSPACE).toMatch(/\.\.\.catalogChatModels, \.\.\.probed/);
    expect(WORKSPACE).toMatch(/probed\.map\(\(id\) => \(\{ id, capability: "", provider: "" \}\)\)/);
    expect(WORKSPACE).toMatch(/onFetched=\{onFetched\}/);
  });
});

describe("unrelated protocol config is untouched", () => {
  it("the configurable protocol list is still the three the gateway serves", () => {
    expect(CONFIGURABLE_PROTOCOLS).toHaveLength(3);
  });
});
