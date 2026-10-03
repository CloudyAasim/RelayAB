/**
 * tests/unit/provider-form-single-source.test.ts
 *
 * One provider form, not two.
 *
 * The create modal and the edit modal were each a hand-written form: the same
 * ten fields, the same validation guard, the same `JSON.stringify({...})`. They
 * drifted, and every entry in this file is a bug that drift produced:
 *
 *  - the edit modal branched on the mode and took the name, base URL, API key
 *    and the model table off the screen in advanced mode;
 *  - `headers` existed only in create, so a request header set at creation could
 *    not be changed afterwards by any UI at all;
 *  - the create path once dropped `textSpecs` from its body, so a protocol
 *    configured in the UI was never written.
 *
 * None of those is an interesting defect on its own. They share a cause — two
 * definitions of one thing, and nothing comparing them — so the fix is that
 * there is now one definition, and these tests are the comparison that was
 * missing.
 *
 * The payload builder is a pure function precisely so it can be compared: call
 * it the way create calls it and the way edit calls it, and the two must agree
 * on every field except the three that are genuinely different.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildProviderPayload,
  facesFromProvider,
  headersToText,
  parseHeaders,
  type ProviderFormValues,
  type ProviderRecord,
} from "@/lib/admin/provider-payload";
import { newModelRow } from "@/app/(admin)/admin/providers/model-rows";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const EDIT = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");
const CREATE = read("src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx");
const FORM = read("src", "app", "(admin)", "admin", "providers", "form", "ProviderForm.tsx");
const HOOK = read("src", "app", "(admin)", "admin", "providers", "form", "use-provider-form.ts");

const MODALS = [
  ["edit", EDIT],
  ["create", CREATE],
] as const;

const values: ProviderFormValues = {
  name: "MiniMax",
  kind: "openai",
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "sk-test",
  priority: "2",
  enabled: true,
  headers: "api-version: 2024-08-01-preview",
  faces: {
    openaiEnabled: true,
    upstreamFormat: "responses",
    anthropicEnabled: true,
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
  },
  modelRows: [newModelRow({ clientId: "abab", upstreamId: "abab-6" })],
  textSpecs: ['{"protocol":"openai-chat"}'],
};

/** How the two call sites actually invoke the builder. */
const asCreate = (v: ProviderFormValues) =>
  buildProviderPayload(v, { nameFallback: "openai", textSpecs: v.textSpecs.length ? v.textSpecs : undefined });
const asEdit = (v: ProviderFormValues) =>
  buildProviderPayload(v, { apiKey: v.apiKey || undefined, textSpecs: v.textSpecs });

describe("the request body is built in one place", () => {
  it("create and edit agree on every field they both send", () => {
    // The drift this file exists for was always a missing or extra key. Compare
    // the two bodies the same way the old bug appeared: one had `headers`, the
    // other did not.
    expect(Object.keys(asCreate(values)).sort()).toEqual(Object.keys(asEdit(values)).sort());
  });

  it("headers reach the body from either form", () => {
    // Create-only, and not sent at all by edit, used to mean "set once, never
    // changeable".
    expect(asCreate(values).headers).toEqual({ "api-version": "2024-08-01-preview" });
    expect(asEdit(values).headers).toEqual({ "api-version": "2024-08-01-preview" });
  });

  it("an empty headers box sends no field rather than an empty object", () => {
    const blank = { ...values, headers: "  \n  " };
    expect(asCreate(blank)).not.toHaveProperty("headers");
    expect(asEdit(blank)).not.toHaveProperty("headers");
  });

  it("both faces and both model tables are always in the body", () => {
    const body = asEdit(values);
    expect(body.openaiEnabled).toBe(true);
    expect(body.anthropicEnabled).toBe(true);
    expect(body.anthropicBaseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(body.upstreamFormat).toBe("responses");
    expect(body.modelMapping).toEqual({ abab: "abab-6" });
  });
});

describe("creating and editing differ only where they must", () => {
  it("an unnamed provider falls back to its template; editing has no fallback", () => {
    const blank = { ...values, name: "" };
    expect(asCreate(blank).name).toBe("openai");
    expect(asEdit(blank).name).toBe("");
  });

  it("a blank key is omitted, so a saved key survives an edit", () => {
    const blank = { ...values, apiKey: "" };
    expect(asCreate(blank)).not.toHaveProperty("apiKey");
    expect(asEdit(blank)).not.toHaveProperty("apiKey");
    expect(asCreate(values).apiKey).toBe("sk-test");
    expect(asEdit(values).apiKey).toBe("sk-test");
  });

  it("create omits an empty protocol list, edit sends it so one can be cleared", () => {
    // Both meanings are "no protocols" and they are not interchangeable: an
    // absent field leaves the stored list alone, `[]` empties it.
    const none = { ...values, textSpecs: [] };
    expect(asCreate(none)).not.toHaveProperty("textSpecs");
    expect(asEdit(none).textSpecs).toEqual([]);
  });

  it("a legacy anthropic row is rewritten into the two-flag shape", () => {
    const legacy: ProviderRecord = {
      name: "x",
      kind: "anthropic",
      baseUrl: null,
      modelMapping: {},
      modelConfigs: {},
      enabled: true,
      upstreamFormat: "anthropic",
    };
    const faces = facesFromProvider(legacy);
    expect(faces.anthropicEnabled).toBe(true);
    expect(faces.openaiEnabled).toBe(false);
    expect(
      buildProviderPayload({ ...values, faces }).upstreamFormat,
    ).toBe("responses");
  });

  it("headers round-trip through the form's text representation", () => {
    const headers = { "api-version": "2024-08-01-preview", "x-trace": "on" };
    expect(parseHeaders(headersToText(headers))).toEqual(headers);
    expect(parseHeaders("")).toBeUndefined();
    expect(parseHeaders("no-colon-here")).toBeUndefined();
  });
});

describe("neither modal keeps its own copy of the form", () => {
  it.each(MODALS)("%s renders the shared form", (_name, src) => {
    expect(src, "this modal does not render ProviderForm").toMatch(/<ProviderForm\b/);
  });

  it.each(MODALS)("%s holds no provider field state of its own", (_name, src) => {
    // The edit modal declared `name`, `baseUrl`, `apiKey`, `priority`, `enabled`,
    // `faces`, `modelRows` and `textSpecs` as its own useState calls — the same
    // eight the create modal declared. Now they live in the hook.
    //
    // Anchored on the destructuring pair, `[name, setName] = useState(`. An
    // earlier version matched the field name *after* `useState`, which never
    // fired: in `const [name, setName] = useState("")` the name is before it.
    // Injecting the state back in passed the guard silently.
    for (const field of ["name", "baseUrl", "apiKey", "priority", "modelRows", "textSpecs", "enabled"]) {
      expect(src, `${_name} declares its own ${field} state`).not.toMatch(
        new RegExp(`\\[\\s*${field}\\s*,\\s*set[A-Z]\\w*\\s*\\]\\s*=\\s*useState`),
      );
    }
    expect(src, `${_name} does not use the shared hook`).toMatch(/useProviderForm\(/);
  });

  it.each(MODALS)("%s builds its body with the shared builder", (_name, src) => {
    // Anchored on the faces being read off a `faces.` local: that is the
    // signature of the old hand-written body, which spelled out every field.
    // A loose "does it contain JSON.stringify" would flag the table row's
    // "fetch models" action, which is a partial patch of just the mapping and
    // is meant to be written by hand.
    expect(src, `${_name} hand-builds the full request body`).not.toMatch(
      /\banthropicBaseUrl:\s*faces\./,
    );
    expect(src, `${_name} does not call the shared builder`).toMatch(/buildPayload\(/);
  });

  it("the fields and the interface block live in the shared form, once", () => {
    // The mode switch and the interface block are now properties of the form
    // rather than of a modal, so neither modal can hide them.
    expect(FORM, "the shared form lost the mode switch").toMatch(/<ProviderModeSwitch\b/);
    expect(FORM, "the shared form lost the interface block").toMatch(/<ProviderInterfacesField\b/);
    expect(FORM, "the shared form lost the headers field").toMatch(/patch\(\{ headers:/);
    expect(HOOK, "the hook no longer validates the protocol list").toMatch(/validateTextSpecs/);
  });

  it("the mode adds the rules and takes nothing away", () => {
    // A ternary hides one branch of the form. The "else" side used to be the
    // name, base URL, API key and the model table, so advanced mode had no key
    // field. The shared form's only mode branch is additive, and it now decides
    // one thing: whether the per-interface rules are shown.
    expect(FORM).toMatch(/showRules=\{mode === "advanced"\}/);
    expect(FORM).not.toMatch(/mode === "advanced" \?/);
    expect((FORM.match(/<ProviderInterfacesField[\s>]/g) ?? []).length).toBe(1);
  });
});

describe("the interface switches and the rules are one control", () => {
  /**
   * These were two blocks: a pair of checkboxes over the same three interfaces
   * a sibling list then offered to edit, with its own vocabulary. Switching the
   * OpenAI side off still left "add /v1/responses" on offer, and the plumbing
   * that reconciled them — a filter, an "inert" badge, a warning, a count — grew
   * a guard for every rule.
   *
   * The rules now live inside the face that gates them, so none of that is
   * reachable. These assert the absence rather than the presence of a filter,
   * because a filter is the thing that should no longer be needed.
   */
  it("one component renders the switches and the rules together", () => {
    const field = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderInterfacesField.tsx",
    );
    expect(field).toMatch(/<SurfaceRule/);
    // The surfaces come from SURFACES, filtered by the face they belong to —
    // the join is structural, not a runtime check.
    expect(field).toMatch(/SURFACES\.filter\(\(s\) => s\.face === face\)/);
  });

  it("there is no reconciliation left to reconcile", () => {
    const field = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderInterfacesField.tsx",
    );
    // A rule for a face that is off cannot be written, so nothing has to mark
    // one as inert.
    expect(field).not.toMatch(/faceOn/);
    expect(field).not.toMatch(/faceOffBadge/);
    // And no "all N configured" line: each face counts its own, from the
    // surfaces it actually owns, so the number cannot go stale.
    expect(field).not.toMatch(/allAdded/);
  });

  it("the two old components are gone rather than left unused", () => {
    for (const name of ["ProviderFacesField.tsx", "TextProtocolField.tsx"]) {
      expect(
        () => read("src", "app", "(admin)", "admin", "providers", name),
        `${name} still exists`,
      ).toThrow();
    }
  });

  it("the shared form hands the live values down in one call", () => {
    expect(FORM).toMatch(/<ProviderInterfacesField[\s\S]*?value=\{values\.faces\}/);
    expect(FORM).toMatch(/<ProviderInterfacesField[\s\S]*?textSpecs=\{values\.textSpecs\}/);
    expect(FORM).toMatch(/<ProviderInterfacesField[\s\S]*?onTextSpecsChange=\{setTextSpecs\}/);
  });
});
