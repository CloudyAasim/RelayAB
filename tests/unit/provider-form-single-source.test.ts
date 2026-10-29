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
  routesFromProvider,
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
const PAYLOAD = read("src", "lib", "admin", "provider-payload.ts");

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
    anthropicMode: "native",
  },
  modelRows: [newModelRow({ clientId: "abab", upstreamId: "abab-6" })],
  textSpecs: ['{"protocol":"openai-chat"}'],
  activeMode: "advanced",
  routes: {
    "openai-chat": { kind: "passthrough" },
    "openai-responses": { kind: "route", dialect: "chat" },
    "anthropic-messages": { kind: "passthrough" },
    "gemini-generate": { kind: "unsupported" },
  },
  protocolMode: "advanced",
  upstreamDialects: ["chat", "anthropic"],
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
    // The face flags are a **summary of the route table** now, not a second
    // answer: the routes are what the editor writes, and the columns that
    // came before them are read by the endpoints that have no table of their
    // own. So the dialect is the first one the routes name.
    expect(body.upstreamFormat).toBe("chat");
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

  it("a legacy anthropic row keeps saying its upstream speaks Anthropic", () => {
    // The old behaviour rewrote `upstreamFormat: "anthropic"` into
    // `"responses"` on save. That was harmless while the value could only mean
    // "this row is Anthropic-only" — a fact the two flags already carried.
    //
    // It is not harmless now. The value also says *how* the OpenAI face is
    // served: an Anthropic-format row with the OpenAI side on is served by
    // translation, and rewriting it would point the next request at a
    // `/v1/responses` endpoint this vendor does not have.
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
    expect(faces.upstreamFormat).toBe("anthropic");
    // The round trip goes through the **routes** now: they are what the form
    // edits and what the builder sends, and the columns that came before them
    // are a summary of the same answer.
    const routes = routesFromProvider(legacy);
    expect(buildProviderPayload({ ...values, faces, routes }).upstreamFormat).toBe("anthropic");
  });

  it("reports the effective dialect, so what is saved is what the engine acts on", () => {
  // A row typed "anthropic" stores "responses" by default — that is the
  // dialect of the OpenAI side, which such a row does not have. The form
  // reports the effective one, so saving the row does not leave it saying
  // something the engine will not act on.
  const typed: ProviderRecord = {
    name: "x",
    kind: "anthropic",
    baseUrl: null,
    modelMapping: {},
    modelConfigs: {},
    enabled: true,
    upstreamFormat: "responses",
  };
  expect(facesFromProvider(typed).upstreamFormat).toBe("anthropic");
  expect(facesFromProvider(typed).anthropicEnabled).toBe(true);
});

it("so turning the OpenAI side on for such a row survives the round trip", () => {
    // The whole point of the round trip: an operator ticks "OpenAI side" on a
    // Claude-only vendor, saves, and the row still says "translate" instead of
    // quietly becoming a Responses upstream.
    const legacy: ProviderRecord = {
      name: "x",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      modelMapping: {},
      modelConfigs: {},
      enabled: true,
      upstreamFormat: "anthropic",
    };
    const faces = { ...facesFromProvider(legacy), openaiEnabled: true };
    // The routes are what the form edits now, so the round trip is the one the
    // editor does: the legacy row's routes, with the OpenAI side turned on.
    const routes = {
      ...routesFromProvider(legacy),
      "openai-chat": { kind: "route", dialect: "anthropic" } as const,
    };
    const body = buildProviderPayload({ ...values, kind: "anthropic", faces, routes });
    expect(body.openaiEnabled).toBe(true);
    expect(body.upstreamFormat).toBe("anthropic");
    expect(body.kind).toBe("anthropic");
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

  it("the fields and the mode live in the shared form, once", () => {
    expect(FORM, "the shared form lost the mode switch").toMatch(/<ProviderModeSwitch\b/);
    expect(FORM, "the shared form lost the headers field").toMatch(/patch\(\{ headers:/);
    expect(HOOK, "the hook no longer validates the protocol list").toMatch(/validateTextSpecs/);
  });

  it("the modes are alternatives: one block each, never both", () => {
    // Simple answers "which interfaces answer, and how", advanced answers "how
    // does each one handle parameters". Rendering them together is what made
    // them contradict each other — a route table saying a surface is
    // unsupported beside a rules list offering to configure it. A branch makes
    // one impossible.
    expect(FORM).toMatch(
      /protocolMode === "simple"[\s\S]{0,400}<ProviderSurfaceRoutes[\s\S]{0,900}<ProviderInterfacesList/,
    );
    for (const name of ["ProviderSurfaceRoutes", "ProviderInterfacesList"]) {
      expect((FORM.match(new RegExp(`<${name}[\\s>]`, "g")) ?? []).length, name).toBe(1);
    }
    // And the two branches are separate blocks — one block each — so the simple
    // branch cannot render the rules list as well.
    const simple = FORM.slice(
      FORM.indexOf('protocolMode === "simple"'),
      FORM.indexOf('protocolMode === "advanced"'),
    );
    expect(simple).toContain("ProviderSurfaceRoutes");
    expect(simple, "the simple branch renders the rules list too").not.toContain(
      "ProviderInterfacesList",
    );
  });

  it("the face flags are saved whichever mode is open", () => {
    // They are columns the proxy routes on, not derivable from the rules: a
    // provider can serve Chat Completions with no rule at all. So they are
    // written in both modes — and now they are written **from the route
    // table**, which is where the operator says what each surface does.
    expect(FORM).toMatch(/anthropicBaseUrl=\{values\.faces\.anthropicBaseUrl\}/);
    expect(PAYLOAD).toMatch(/openaiEnabled: derived\.openaiEnabled/);
    expect(PAYLOAD).toMatch(/anthropicEnabled: derived\.anthropicEnabled/);
  });
});

describe("the mode is a saved value, not a view", () => {
  it("whichever mode is open, the body carries it", () => {
    // The mode used to be a second `useState` in the hook that the builder
    // never read, so moving the switch changed nothing that was written and the
    // only true reading of the screen was "this is a display option". The whole
    // point of keeping both configurations is that the engine knows which one
    // is live, which means the choice has to arrive.
    //
    // Three configurations now, and the third one — passthrough, where nothing
    // is translated at all — is a choice too.
    for (const mode of ["simple", "advanced", "passthrough"] as const) {
      expect(asEdit({ ...values, protocolMode: mode }).protocolMode).toBe(mode);
      expect(asCreate({ ...values, protocolMode: mode }).protocolMode).toBe(mode);
    }
    // And the legacy column follows the new one: a row in passthrough mode has
    // no rules applying, which is what `simple` means to the reader of it.
    expect(asEdit({ ...values, protocolMode: "passthrough" }).activeMode).toBe("simple");
    expect(asEdit({ ...values, protocolMode: "advanced" }).activeMode).toBe("advanced");
  });

  it("the inactive configuration still goes with it", () => {
    // Switching to simple must park the rules, not drop them: a payload that
    // omitted the list in simple mode would lose the configuration on save,
    // which is the one outcome the two-configurations design exists to prevent.
    const simple = { ...values, activeMode: "simple" as const };
    expect(asEdit(simple).textSpecs).toEqual(values.textSpecs);
  });

  it("the hook keeps no second mode state to fall out of step with", () => {
    // Anchored on the destructuring pair, the same shape the field-state guard
    // above uses. A `useState` for the mode would be a value the payload cannot
    // see, which is the drift this file was written for.
    expect(HOOK, "the hook holds the mode beside the values").not.toMatch(
      /\[\s*mode\s*,\s*setMode\s*\]\s*=\s*useState/,
    );
    expect(HOOK, "the hook no longer reads the mode off the values").toMatch(
      /const mode = values\.activeMode/,
    );
    expect(HOOK, "setMode does not write to the values").toMatch(
      /setValues\(\(prev\) => \(\{ \.\.\.prev, activeMode: next \}\)\)/,
    );
  });
});

describe("each mode's block says what it is for", () => {
  it("the route table is about which endpoints answer, and how", () => {
    const routes = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderSurfaceRoutes.tsx",
    );
    // One row per surface, and three answers each.
    expect(routes).toMatch(/SURFACES\.map\(/);
    expect(routes).toContain("admin.providers.routes.unsupported");
    expect(routes).toContain("admin.providers.routes.passthrough");
    expect(routes).toContain("admin.providers.routes.route");
    // It is the only place the Anthropic base URL is set.
    expect(routes).toMatch(/anthropicBaseUrl/);
    // No rules here — that is the other mode's job.
    expect(routes).not.toMatch(/textSpec/);
  });

  it("the rules list is one flat row per interface, and always all of them", () => {
    const list = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderInterfacesList.tsx",
    );
    expect(list).toMatch(/SURFACES\.map\(/);
    // No grouping by face: with no switch beside it, a heading that says "these
    // answer" is one more thing that reads as a control.
    expect(list).not.toMatch(/s\.face ===/);
    // And no filtering against the face flags — the list cannot be narrowed by
    // a switch the user cannot see in this mode.
    expect(list).not.toMatch(/faceOn/);
  });

  it("neither block carries the other's job", () => {
    const routes = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderSurfaceRoutes.tsx",
    );
    const list = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderInterfacesList.tsx",
    );
    expect(routes, "the route block is editing rules").not.toMatch(/textSpecs/);
    expect(list, "the rules list is switching interfaces").not.toMatch(/openaiEnabled/);
  });

  it("the count of configured rules is computed, not written", () => {
    // It was "四个接口都已配置。" once, and survived the removal of the fourth.
    const list = read(
      "src", "app", "(admin)", "admin", "providers", "ProviderInterfacesList.tsx",
    );
    expect(list).toMatch(/SURFACES\.filter\(\(s\) => ruleFor\(textSpecs, s\.id\) !== undefined\)\.length/);
    expect(list).toMatch(/allConfigured", \{ n: SURFACES\.length \}/);
  });
});
