/**
 * The thinking switch has to be findable, and the advice about it has to be true.
 *
 * Two things went missing, in opposite directions:
 *
 *  - The parameter that *is* the switch — MiniMax takes `thinking.type`, not
 *    `reasoning_effort` — was not declared in the chat preset. Undeclared
 *    parameters pass through, so nothing was broken; but the spec exists so the
 *    background page can show an operator what a protocol accepts, and a switch
 *    nobody can see is a switch nobody finds. The same argument applies to
 *    `output_config`, which is where a vendor puts thinking depth on its
 *    Anthropic surface, and to `reasoning_split`, which moves the thinking
 *    content and so decides whether a reader looking at the separated field
 *    sees any.
 *
 *  - The assistant was told the levels are declared from the vendor's
 *    documentation, and nothing else. So "turn thinking off" had exactly one
 *    thing it could do — clear the list — which changes our own dropdown and
 *    the request not at all. Worse, leaving the setting alone is not a neutral
 *    act: for one of these models the untouched default is its most expensive
 *    level, and for the other it means thinking stays on.
 *
 * The preset checks parse the shipped presets rather than reading their source,
 * so a rule that is only described in a comment cannot satisfy them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIGURABLE_PROTOCOLS,
  TEXT_PROTOCOL_PRESETS,
  protocolPreset,
} from "@/lib/protocol/text-protocols";
import { parseTextSpec } from "@/lib/protocol/text-spec";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const PANEL_SOURCE = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");
const FORM_SOURCE = read("src", "app", "(admin)", "admin", "model-notes", "ModelConfigForm.tsx");
const DICT_SOURCE = read("src", "lib", "i18n", "dict.ts");
const TOOLS_SOURCE = read("src", "lib", "assistant", "tools.ts");

/** The declared parameters of a preset, as the background page would list them. */
function declared(protocol: keyof typeof TEXT_PROTOCOL_PRESETS): string[] {
  return Object.keys(TEXT_PROTOCOL_PRESETS[protocol].parameters ?? {});
}

describe("the thinking switch is declared where a client can find it", () => {
  it("the chat preset names `thinking`, not only `reasoning_effort`", () => {
    // The two are different questions. One vendor's `reasoning_effort` tunes
    // depth; another's switch is `thinking.type` and cannot be reached by
    // sending an effort at all. A preset that names only the first tells an
    // operator the wrong thing is missing.
    expect(declared("openai-chat")).toContain("thinking");
  });

  it("and names where the thinking content goes", () => {
    // A client that reads only the separated field concludes a thinking model is
    // not thinking. That is a false negative about the vendor, produced by
    // where we put its output, and the parameter that decides it should be
    // visible next to the one that decides whether it thinks.
    expect(declared("openai-chat")).toContain("reasoning_split");
  });

  it("the Anthropic preset names `output_config`", () => {
    // On this surface the depth is not `reasoning_effort` at all. A spec that
    // forwards `reasoning_effort` to a vendor that has never heard of it looks
    // configured and changes nothing.
    expect(declared("anthropic-messages")).toContain("output_config");
  });

  it("every configurable preset still parses", () => {
    // The declarations above are only worth anything if the documents they went
    // into are ones an operator can actually store.
    for (const protocol of CONFIGURABLE_PROTOCOLS) {
      const parsed = parseTextSpec(protocolPreset(protocol));
      expect(parsed.ok, `${protocol}: ${parsed.ok ? "" : parsed.errors.join("; ")}`).toBe(true);
    }
  });

  it("and a preset handed out for editing is a copy, not the original", () => {
    // The editor mutates what it is given. A preset that could be mutated would
    // change the next operator's starting point.
    const a = protocolPreset("openai-chat");
    const b = protocolPreset("openai-chat");
    a.parameters!.thinking = { mode: "drop" };
    expect(b.parameters!.thinking).toEqual({ mode: "passthrough" });
  });
});


describe("the settings form does not let 'default' stand for 'off'", () => {
  const DICT = read("src", "lib", "i18n", "dict.ts");
  const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");

  it("labels the empty option as what it is", () => {
    // "Off" would be a lie: the option sends nothing, and nothing is the
    // vendor's choice, which for some models is thinking at its deepest.
    expect(DICT).toContain('"assistant.settings.reasoningOff": "默认（不发送）"');
    expect(DICT).toContain('"assistant.settings.reasoningOff": "Default (not sent)"');
  });

  it("says so on the screen, next to the field", () => {
    // In the dictionary and nowhere else is a string nobody reads. The claim is
    // about what happens when the user does nothing, so it belongs where the
    // option they are about to pick is.
    expect(PANEL).toContain("reasoningDefaultIsNotOff");
  });
});

describe("a model that ignores the effort parameter has its control switched off", () => {
  it("the panel disables it, and only on an explicit false", () => {
    // The distinction the whole flag exists for. An empty level list is also
    // what a model nobody has declared anything about looks like, and that one
    // must keep a live free-text field — otherwise adding the column would have
    // switched off a working control for every model on the deployment.
    expect(PANEL_SOURCE).toContain("facts?.reasoningEffortSupported === false");
    expect(PANEL_SOURCE).toMatch(/disabled=\{effortUnsupported\}/);
  });

  it("and tells the user why, instead of only greying it out", () => {
    // A disabled control with no explanation reads as a bug, and the user has no
    // way to tell which of "broken" and "this model has no levels" it is. The
    // second half of the sentence — use the switch beside it — is what makes it
    // an answer rather than a dead end.
    expect(PANEL_SOURCE).toContain("reasoningNotSupported");
    expect(DICT_SOURCE).toContain("assistant.settings.reasoningNotSupported");
    expect(DICT_SOURCE).toContain("思考开关");
  });

  it("the operator can declare it, and the default leaves controls alone", () => {
    // Declared, not inferred. Someone has to have read the vendor's
    // documentation to know this, and the checkbox is how that reaches us.
    expect(FORM_SOURCE).toMatch(/type="checkbox"/);
    expect(FORM_SOURCE).toContain("row.reasoningEffortSupported !== false");
  });

  it("the assistant can set the same declaration", () => {
    expect(TOOLS_SOURCE).toContain("reasoningEffortSupported");
  });
});
