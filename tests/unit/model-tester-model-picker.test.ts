/**
 * tests/unit/model-tester-model-picker.test.ts
 *
 * The model pickers were closed.
 *
 * Both testers rendered a `<select>`, whose value can only be one of its
 * options. So a model the catalog did not list could not be tested at all:
 * not one from a vendor added after the last catalog rebuild, not an id you
 * wanted to reproduce a failure with, not a typo on purpose. And the probe
 * beside them — the one tool that can ask a vendor what models it serves —
 * showed its result as text with nowhere to go, so a freshly listed model was
 * visible and untestable in the same breath.
 *
 * The ask was a dropdown that can be filled in automatically while still
 * allowing manual entry. An `<input list>` plus a `<datalist>` is both halves
 * in one control, and the probe now hands its ids up into the lists.
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

const TESTERS = [
  ["ModelTester", CHAT],
  ["MediaTester", MEDIA],
] as const;

describe("a model can be picked or typed", () => {
  it.each(TESTERS)("%s offers a list and still takes free text", (_name, src) => {
    // The regression: a closed `<select>` renders the same options but cannot
    // hold a value that is not one of them.
    expect(src).toMatch(/<input[\s\S]{0,200}list="/);
    expect(src).toMatch(/<datalist id="/);
    expect(src).not.toMatch(/<select\s+id="(model-tester-model|media-model)"/);
  });

  it.each(TESTERS)("%s still offers every known model as an option", (_name, src) => {
    expect(src).toMatch(/<option key=/);
  });
});

describe("the probe's models reach the pickers", () => {
  it("it reports what it listed", () => {
    expect(PROBE).toMatch(/onFetched\?: \(models: string\[\]\) => void/);
    expect(PROBE).toMatch(/onFetched\?\.\(json\.data\.models\)/);
  });

  it("the workspace merges them into both lists, without losing the catalogue", () => {
    expect(WORKSPACE).toMatch(/const \[probed, setProbed\] = useState<string\[\]>\(\[\]\)/);
    expect(WORKSPACE).toMatch(/\[\.\.\.new Set\(\[\.\.\.catalogChatModels, \.\.\.probed\]\)\]/);
    expect(WORKSPACE).toMatch(/onFetched=\{onFetched\}/);
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

describe("the media pickers do not regress on the probe shape", () => {
  it("the capability label map is still there for catalogued models", () => {
    // A datalist option can carry a label; the tester still resolves the badge
    // below the field from the model list it was given.
    expect(MEDIA).toMatch(/CAP_LABEL\[m\.capability\]/);
    expect(MEDIA).toMatch(/current\.capability/);
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
