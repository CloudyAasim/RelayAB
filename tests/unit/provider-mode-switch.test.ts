/**
 * tests/unit/provider-mode-switch.test.ts
 *
 * The provider editor offers two ways to configure the same provider.
 *
 * The protocol used to be a block under the provider table, which put the two
 * things you configure together — which endpoint this vendor is, and what it
 * does with the parameters in a request — on two screens, with the harder half
 * the one you had to go looking for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const EDIT = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");
const CREATE = read("src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx");
const PAGE = read("src", "app", "(admin)", "admin", "providers", "page.tsx");
const FIELD = read("src", "app", "(admin)", "admin", "providers", "TextProtocolField.tsx");
const API_PATCH = read("src", "app", "api", "admin", "providers", "[id]", "route.ts");
const API_POST = read("src", "app", "api", "admin", "providers", "route.ts");

describe("there are two ways to configure a provider", () => {
  it("and both the editor and the create form offer them", () => {
    for (const [name, src] of [
      ["the edit modal", EDIT],
      ["the create form", CREATE],
    ] as const) {
      expect(src, `${name} has no mode switch`).toContain("ProviderModeSwitch");
      expect(src, `${name} does not use the protocol field`).toContain("TextProtocolField");
    }
  });

  it("the protocol is no longer a separate block under the table", () => {
    // The complaint that started this: two screens for one provider.
    expect(PAGE).not.toContain("TextProtocolPanel");
    expect(PAGE).not.toMatch(/<TextProtocolField/);
  });

  it("the switch is inside the form in both places, so its own state is submitted", () => {
    // Outside the form, switching modes would be a separate transaction from
    // saving — and a protocol is part of the provider, not beside it.
    expect(EDIT).toMatch(/<form onSubmit=\{handleSubmit\}[\s\S]*?<ProviderModeSwitch/);
    expect(CREATE).toMatch(/<form onSubmit=\{onSubmit\}[\s\S]*?<ProviderModeSwitch/);
  });
});

describe("the two modes are not two views of one thing", () => {
  it("the simple form's fields are sent whichever mode is open", () => {
    // A protocol governs the parameters on the way; it does not decide which
    // endpoint is called. Saving in advanced mode must not clear the models.
    expect(EDIT).toMatch(/\.\.\.rowsToPayload\(modelRows\),[\s\S]*?textSpec: textSpec\.trim\(\) \? textSpec : null,/);
    expect(CREATE).toMatch(/modelMapping,\n\s+modelConfigs,[\s\S]*?textSpec/);
  });

  it("so the mode only decides what is *shown*, never what is sent", () => {
    expect(EDIT).toMatch(/\{mode === "advanced" \? \(/);
  });

  it("an invalid spec blocks the save and sends you to the mode that shows it", () => {
    // Otherwise the button reports a protocol problem while the simple form is
    // on screen, and the operator has no idea which box is wrong.
    for (const src of [EDIT, CREATE]) {
      expect(src).toMatch(/if \(specVerdict\.kind === "bad"\) \{[\s\S]*?setMode\("advanced"\)/);
    }
  });
});

describe("the editor opens on the mode the provider is actually configured in", () => {
  it("advanced when a spec is set, simple when it is not", () => {
    // Reopening a provider you configured through the protocol and being shown
    // the simple form is how a spec gets overwritten without anybody touching it.
    expect(EDIT).toMatch(/useState<"simple" \| "advanced">\(\s*provider\.textSpec \? "advanced" : "simple",?\s*\)/);
    expect(EDIT).toMatch(/setMode\(provider\.textSpec \? "advanced" : "simple"\)/);
  });

  it("and the tab says so, rather than looking unconfigured", () => {
    expect(FIELD).toMatch(/hasSpec \? t\("admin\.textSpec\.mode\.advancedSet"\)/);
  });

  it("while a new provider starts simple, because that is right for almost all of them", () => {
    expect(CREATE).toMatch(/useState<"simple" \| "advanced">\("simple"\)/);
  });
});

describe("an empty protocol box is how you go back to plain forwarding", () => {
  it("and it is a null, not an empty string", () => {
    // `""` is not a valid spec; `null` is the documented "no protocol" state.
    expect(EDIT).toMatch(/textSpec: textSpec\.trim\(\) \? textSpec : null/);
  });

  it("a create with no spec does not send the field at all", () => {
    // Nothing configured is not the same as "configured as nothing".
    expect(CREATE).toMatch(/\.\.\.\(textSpec\.trim\(\) \? \{ textSpec \} : \{\}\)/);
  });
});

describe("the endpoint refuses an invalid spec on both verbs", () => {
  it("a patch and a create validate the same way", () => {
    for (const src of [API_PATCH, API_POST]) {
      expect(src).toMatch(/textSpec:[\s\S]*?superRefine/);
      expect(src).toMatch(/parseTextSpec\(parsed\)/);
    }
  });

  it("and a create actually stores it", () => {
    // The bug this file's neighbour was written for: the schema accepted it, the
    // merge did not, and a save returned 200 with nothing in the column.
    expect(API_POST).toMatch(/textSpec: parsed\.data\.textSpec \?\? null/);
  });
});

describe("the panel it replaced is gone", () => {
  it("the standalone component is no longer in the tree", () => {
    expect(() =>
      read("src", "app", "(admin)", "admin", "providers", "TextProtocolPanel.tsx"),
    ).toThrow();
  });

  it("and its verdict logic moved into the shared field", () => {
    expect(FIELD).toMatch(/export function judgeTextSpec/);
    // A create form and an edit form both judging a spec needs one judge, or
    // they will eventually disagree about the same text.
    expect(EDIT).toMatch(/judgeTextSpec/);
    expect(CREATE).toMatch(/judgeTextSpec/);
  });
});
