/**
 * tests/unit/provider-mode-switch.test.ts
 *
 * The provider editor: two mutually exclusive modes, and a list of protocols
 * underneath the advanced one.
 *
 * Three things have to hold, and each has a way of quietly failing:
 *
 *  - the modes are **exclusive and legible**. The complaint was that you could
 *    not tell which one you were in; a two-segment pill with a background tint
 *    is not a thing anybody reads.
 *  - the advanced half is a **list**. A provider that serves Chat Completions
 *    and Anthropic Messages has two parameter vocabularies, and one document
 *    could only ever describe one of them.
 *  - the modes configure **different fields of the same row**, so neither save
 *    can clear the other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SURFACES,
  readTextSpecs,
  specForSurface,
  validateTextSpecs,
} from "@/lib/protocol/text-specs";
import { protocolPreset } from "@/lib/protocol/text-protocols";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const EDIT = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");
const CREATE = read("src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx");
const PAGE = read("src", "app", "(admin)", "admin", "providers", "page.tsx");
const FIELD = read("src", "app", "(admin)", "admin", "providers", "TextProtocolField.tsx");
const API_PATCH = read("src", "app", "api", "admin", "providers", "[id]", "route.ts");
const API_POST = read("src", "app", "api", "admin", "providers", "route.ts");
const DB = read("src", "lib", "db", "providers.ts");
const SQLITE = read("src", "lib", "db", "sqlite.ts");
const OPENAI = read("src", "lib", "proxy", "openai.ts");
const ANTHROPIC = read("src", "lib", "proxy", "anthropic.ts");

const spec = (protocol: string) => JSON.stringify(protocolPreset(protocol as never));

describe("which interfaces are on is not a mode's business", () => {
  it("both checkboxes are independent, so one provider can serve both", () => {
    // This predates the two modes and is the actual answer to "can one provider
    // take OpenAI-compatible and Anthropic calls": one row, two faces, one key
    // and one model table shared between them.
    const FACES = read("src", "app", "(admin)", "admin", "providers", "ProviderFacesField.tsx");
    expect(FACES).toMatch(/openaiEnabled: boolean;/);
    expect(FACES).toMatch(/anthropicEnabled: boolean;/);
    expect(FACES).toMatch(/const openaiOn = value\.openaiEnabled && !legacyAnthropicOnly;/);
    // "Neither on" is warned about, which is only worth doing because "both on"
    // is legitimate.
    expect(FACES).toMatch(/admin\.providers\.faces\.noneWarning/);
  });

  it("and it is rendered outside the mode branch, in both places", () => {
    // It is a property of the provider. Behind "simple" you had to flip back and
    // forth to turn a face on after writing rules for it.
    //
    // The two forms spell the branch differently — the edit modal hides one half
    // with a ternary, the create form shows one with `&&` — so the branch is
    // named per file rather than assumed.
    const branchOf = (src: string) =>
      Math.max(
        src.indexOf('mode === "advanced" ?'),
        src.indexOf('mode === "advanced" &&'),
      );
    // Boundary-aware: `indexOf("<ProviderFacesField")` also finds
    // `<ProviderFacesFieldGone`, so renaming the tag to hide it would sail
    // straight past a plain substring search.
    const at = (src: string, tag: string) => src.search(new RegExp(`${tag}[\\s>]`));
    for (const src of [EDIT, CREATE]) {
      const switchAt = at(src, "<ProviderModeSwitch");
      const facesAt = at(src, "<ProviderFacesField");
      const branchAt = branchOf(src);
      expect(facesAt, "no interface selector").toBeGreaterThan(-1);
      expect(branchAt, "no mode branch").toBeGreaterThan(-1);
      expect(
        switchAt < facesAt && facesAt < branchAt,
        "the selector must sit between the mode switch and the branch",
      ).toBe(true);
    }
  });

  it("and a rule for a face that is off says so", () => {
    // The trap this closes: a rule written for an interface nothing calls is
    // saved, looks configured, and never runs. Same shape as offering a protocol
    // nothing can select.
    const FACES = read("src", "app", "(admin)", "admin", "providers", "ProviderFacesField.tsx");
    expect(FACES).toMatch(/configured\?: string\[\]/);
    expect(FACES).toMatch(/const orphanFor = \(protocol: string\): boolean/);
    expect(FACES).toMatch(/orphanFor\("openai-chat"\)/);
    expect(FACES).toMatch(/orphanFor\("anthropic-messages"\)/);
    // And the call sites pass what is configured, so the warning is not
    // permanently on.
    expect(EDIT).toMatch(/<ProviderFacesField[\s\S]*?configured=\{/);
    expect(CREATE).toMatch(/<ProviderFacesField[\s\S]*?configured=\{/);
  });
});

describe("the two modes are exclusive, and say so", () => {
  it("both the editor and the create form offer them", () => {
    for (const src of [EDIT, CREATE]) {
      expect(src).toContain("ProviderModeSwitch");
      expect(src).toContain("TextProtocolField");
    }
  });

  it("as cards with a written state, not a pressed tint", () => {
    // "Which mode am I in" is a question the operator asked out loud, so the
    // answer is a word on the card, not a background colour.
    expect(FIELD).toMatch(/aria-pressed=\{on\}/);
    expect(FIELD).toMatch(/mode === "simple" \? t\("admin\.textSpec\.mode\.current"\)/);
    expect(FIELD).toMatch(/mode === "advanced" \? t\("admin\.textSpec\.mode\.current"\)/);
    expect(FIELD).toMatch(/admin\.textSpec\.mode\.simpleBody/);
    expect(FIELD).toMatch(/admin\.textSpec\.mode\.advancedBody/);
  });

  it("with a hint that they configure the same provider", () => {
    expect(FIELD).toMatch(/admin\.textSpec\.modeHint/);
  });

  it("and the switch is inside the form in both places", () => {
    // Outside the form, switching would be a separate transaction from saving.
    expect(EDIT).toMatch(/<form onSubmit=\{handleSubmit\}[\s\S]*?<ProviderModeSwitch/);
    expect(CREATE).toMatch(/<form onSubmit=\{onSubmit\}[\s\S]*?<ProviderModeSwitch/);
  });

  it("the protocol is no longer a separate block under the table", () => {
    expect(PAGE).not.toContain("TextProtocolPanel");
    expect(PAGE).not.toMatch(/<TextProtocolField/);
  });
});

describe("the advanced half is a list, one entry per interface", () => {
  it("the surfaces the gateway actually serves", () => {
    expect(SURFACES.map((s) => s.id)).toEqual([
      "openai-chat",
      "openai-responses",
      "anthropic-messages",
    ]);
    // There is no `/v1beta/models/*:generateContent` here, so offering a
    // `gemini-generate` entry would be a field that saves and does nothing:
    // nothing would ever select it. The preset is kept below the picker, not
    // deleted — it is the right answer the day that endpoint exists.
    expect(SURFACES.some((s) => s.id === ("gemini-generate" as string))).toBe(false);
    const protocols = read("src", "lib", "protocol", "text-protocols.ts");
    expect(protocols).toMatch(/CONFIGURABLE_PROTOCOLS = \[\s*"openai-chat",\s*"openai-responses",\s*"anthropic-messages",\s*\]/);
    expect(FIELD).toMatch(/CONFIGURABLE_PROTOCOLS/);
    // And the gateway really has those three client surfaces.
    for (const route of ["v1/chat/completions", "v1/responses", "anthropic/v1/messages"]) {
      expect(() => read("src", "app", "api", ...route.split("/"), "route.ts"), route).not.toThrow();
    }
  });

  it("a provider can configure more than one", () => {
    const entries = [spec("openai-chat"), spec("anthropic-messages")];
    expect(specForSurface(readTextSpecs({ textSpecs: entries }), "openai-chat")?.protocol).toBe(
      "openai-chat",
    );
    expect(specForSurface(readTextSpecs({ textSpecs: entries }), "anthropic-messages")?.protocol).toBe(
      "anthropic-messages",
    );
  });

  it("each entry governs its own surface, and the proxy picks by surface", () => {
    // The whole point: a Chat-shaped rule must not be applied to an Anthropic
    // request, because the two name the same thing differently.
    const entries = [spec("openai-chat"), spec("anthropic-messages")];
    const stored = readTextSpecs({ textSpecs: entries });
    expect(specForSurface(stored, "openai-responses")).toBeNull();
    expect(OPENAI).toMatch(/specForSurface\(readTextSpecs\(provider\), "openai-chat"\)/);
    expect(OPENAI).toMatch(/specForSurface\(readTextSpecs\(provider\), "openai-responses"\)/);
    expect(ANTHROPIC).toMatch(/specForSurface\(readTextSpecs\(provider\), "anthropic-messages"\)/);
  });

  it("no entry for a surface means the request is forwarded as sent", () => {
    expect(specForSurface(readTextSpecs({ textSpecs: [] }), "openai-chat")).toBeNull();
    expect(specForSurface(readTextSpecs({}), "openai-chat")).toBeNull();
  });

  it("gemini drops out of the picker, because nothing would select it", () => {
    // The rule this file was corrected by: an option nothing can select is a
    // lie, and a lie in a configuration UI costs more than the option is worth.
    // Asserted on the list itself, not on a comment about it.
    const protocols = read("src", "lib", "protocol", "text-protocols.ts");
    // Exactly the three surfaces, no more. `[^]]*` so the match cannot run past
    // the closing bracket into the presets further down the file.
    expect(protocols).toMatch(
      /CONFIGURABLE_PROTOCOLS = \[\s*"openai-chat",\s*"openai-responses",\s*"anthropic-messages",\s*\] as const;/,
    );
    // The preset itself is kept, and says why it is not offered.
    expect(protocols).toMatch(/rather than deleted: it is the right answer the day that endpoint exists/);
  });

  it("two entries for one protocol is refused, because one of them never runs", () => {
    // Which one wins is decided by array order — invisible to whoever is editing.
    const result = validateTextSpecs([spec("openai-chat"), spec("openai-chat")]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join()).toMatch(/配置了两条/);
  });

  it("a malformed entry is named, and a bad list is refused", () => {
    const result = validateTextSpecs(["{not json"]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join()).toMatch(/第 1 条/);
  });

  it("a bad entry in a row does not take the provider offline", () => {
    // The same row carries the key and the models. One malformed document must
    // not make a working provider unreachable; the editor is where it gets fixed.
    const entries = readTextSpecs({ textSpecs: ["{not json", spec("openai-chat")] });
    expect(entries).toHaveLength(1);
    expect(entries[0].protocol).toBe("openai-chat");
  });

  it("and a row written before the list existed still resolves", () => {
    // `ADD COLUMN` cannot drop the old one, so a legacy single document has to
    // keep working as a one-entry list rather than being orphaned.
    expect(SQLITE).toMatch(/row\.text_spec/);
    expect(SQLITE).toMatch(/legacy \? \[legacy\] : \[\]/);
  });
});

describe("the modes configure different fields of the same row", () => {
  it("the simple form's fields are sent whichever mode is open", () => {
    expect(EDIT).toMatch(/\.\.\.rowsToPayload\(modelRows\),[\s\S]*?textSpecs,/);
    expect(CREATE).toMatch(/modelMapping,\n\s+modelConfigs,[\s\S]*?textSpecs/);
  });

  it("so the mode only decides what is *shown*, never what is sent", () => {
    expect(EDIT).toMatch(/\{mode === "advanced" \? \(/);
  });

  it("an invalid spec blocks the save and sends you to the mode that shows it", () => {
    // Otherwise the button reports a protocol problem while the simple form is
    // on screen, and the operator has no idea which box is wrong.
    for (const src of [EDIT, CREATE]) {
      expect(src).toMatch(/if \(!specVerdict\.ok\) \{[\s\S]*?setMode\("advanced"\)/);
    }
  });

  it("an empty list is how you go back to plain forwarding", () => {
    // `""` is not a valid spec; `[]` is the documented "no policy" state.
    expect(EDIT).toMatch(/textSpecs,/);
    expect(API_PATCH).toMatch(/textSpecs: z\s*\.array/);
  });

  it("a create with no protocol does not send the field at all", () => {
    expect(CREATE).toMatch(/\.\.\.\(textSpecs\.length \? \{ textSpecs \} : \{\}\)/);
  });
});

describe("the editor opens on the mode the provider is actually configured in", () => {
  it("advanced when a list has entries, simple when it is empty", () => {
    expect(EDIT).toMatch(/provider\.textSpecs\?\.length \? "advanced" : "simple"/);
    expect(EDIT).toMatch(/setMode\(provider\.textSpecs\?\.length \? "advanced" : "simple"\)/);
  });

  it("and the card reports how many interfaces are configured", () => {
    // The count is passed in at the call sites and printed on the card.
    expect(EDIT).toMatch(/interfaceCount=\{textSpecs\.length\}/);
    expect(CREATE).toMatch(/interfaceCount=\{textSpecs\.length\}/);
    expect(FIELD).toMatch(/admin\.textSpec\.mode\.configured/);
  });

  it("while a new provider starts simple, because that is right for almost all of them", () => {
    expect(CREATE).toMatch(/useState<"simple" \| "advanced">\("simple"\)/);
  });
});

describe("the endpoint refuses an invalid spec on both verbs", () => {
  it("a patch and a create validate the same way", () => {
    for (const src of [API_PATCH, API_POST]) {
      expect(src).toMatch(/textSpecs: z\s*\.array[\s\S]*?superRefine/);
      expect(src).toMatch(/validateTextSpecs\(value \?\? \[\]\)/);
    }
  });

  it("and both actually store it", () => {
    // The bug this file's neighbour was written for, twice: the schema accepted
    // it, the route passed it on, and the statement did not name the column —
    // so a create answered 200 with nothing stored.
    expect(API_POST).toMatch(/textSpecs: parsed\.data\.textSpecs \?\? \[\]/);
    expect(DB).toMatch(/textSpecs: input\.textSpecs \?\? \[\],/);
    expect(DB).toMatch(/anthropic_base_url, text_specs,\n\s+created_at, updated_at\)/);
    expect(DB).toMatch(/anthropic_enabled = \?, anthropic_base_url = \?, text_specs = \?/);
    // The old column is read, never written: it would make the value list and
    // the column list disagree, and `updated_at` would go in as undefined.
    expect(DB).not.toMatch(/text_spec,/);
  });
});

describe("the panel it replaced is gone", () => {
  it("the standalone component is no longer in the tree", () => {
    expect(() =>
      read("src", "app", "(admin)", "admin", "providers", "TextProtocolPanel.tsx"),
    ).toThrow();
  });

  it("and one judge serves the editor, the create form and the endpoint", () => {
    expect(FIELD).toMatch(/export function judgeTextSpec/);
    expect(EDIT).toMatch(/validateTextSpecs/);
    expect(CREATE).toMatch(/validateTextSpecs/);
  });
});
