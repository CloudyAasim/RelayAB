/**
 * tests/unit/assistant-protocol-sync.test.ts
 *
 * The assistant and the tester still spoke the old single-protocol shape.
 *
 * Provider protocols became a list, one per compatibility interface, and four
 * places were left behind — each of them looking fine on its own:
 *
 *  - `propose_provider_update` wrote `patch.textSpec`, a single string. The
 *    apply schema accepted that key and `updateProvider` read `textSpecs`, so
 *    the proposal was approved, the diff reported it, and the database was not
 *    touched. The tool's own comment says a spec that does not survive apply is
 *    worse than a rejected one, because it spends an administrator's approval
 *    on nothing.
 *  - `listProvidersTool` handed over one `textSpec`, hiding the other two.
 *  - `list_text_protocols` walked `TEXT_PROTOCOL_LABELS`, which still carries
 *    `gemini-generate` — a preset with no route to select it. The editor had
 *    already stopped offering it; the assistant was still recommending it.
 *  - the model tester explained a Chat Completions request using whichever
 *    entry `readTextSpec` folded the list down to, which on a provider serving
 *    both surfaces is the *other* interface's rule.
 *
 * The shape of all four is the same: something that has to be updated when a
 * field changes shape, and nothing that fails when it does not. These tests
 * fail when the tool writes a key the apply schema does not accept, when a
 * caller is told about a protocol the editor will not offer, and when the
 * tester resolves a rule without naming the surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIGURABLE_PROTOCOLS, TEXT_PROTOCOL_LABELS } from "@/lib/protocol/text-protocols";
import { SURFACES } from "@/lib/protocol/text-specs";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const TOOLS = read("src", "lib", "assistant", "tools.ts");
const NOTES = read("src", "lib", "assistant", "deployment-notes.ts");
const DIFF = read("src", "lib", "assistant", "diff.ts");
const APPLY = read("src", "app", "api", "assistant", "actions", "[id]", "route.ts");
const TEST_MODEL = read("src", "app", "api", "assistant", "test-model", "route.ts");
const DB = read("src", "lib", "db", "providers.ts");

/** The tool's function body, from its signature to the next top-level one. */
function toolBody(name: string): string {
  const start = TOOLS.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const rest = TOOLS.slice(start + 1);
  const next = rest.search(/\n(?:export )?(?:async )?function [A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("a protocol proposal survives approval", () => {
  it("the tool writes the key the apply schema accepts", () => {
    // The whole failure in one line: a key the schema tolerates, and the
    // database layer never reads.
    const body = toolBody("proposeProviderUpdate");
    expect(body).not.toMatch(/\bpatch\.textSpec\s*=/);
    expect(body).toMatch(/\bpatch\.textSpecs\s*=/);
  });

  it("the schema and the database layer agree on the name and the type", () => {
    // Three files, one field. If any of them drifts, the proposal is approved
    // and discarded — the worst outcome, because the diff said it worked.
    expect(APPLY).toMatch(/textSpecs: z\.array\(z\.string\(\)/);
    expect(APPLY).not.toMatch(/textSpec: z\.string\(\)/);
    expect(DB).toMatch(/textSpecs\?: string\[\];/);
    // And the layer that writes the column.
    expect(DB).toMatch(/textSpecs: patch\.textSpecs \?\? existing\.textSpecs/);
  });

  it("the diff shows the protocol change instead of silently listing no field", () => {
    // A diff the administrator reads to decide is the last place a change can
    // be invisible.
    expect(DIFF).toMatch(/if \(patch\.textSpecs !== undefined\)/);
    expect(DIFF).toMatch(/byProtocol/);
  });

  it("providers are shown with the full list, not a single document", () => {
    const body = toolBody("listProvidersTool");
    expect(body).toMatch(/textSpecs: p\.textSpecs \?\? \[\]/);
    expect(body).not.toMatch(/\btextSpec: readTextSpec\(/);
  });
});

describe("the assistant only offers protocols the editor offers", () => {
  it("list_text_protocols walks the configurable list, not every label", () => {
    const body = toolBody("listTextProtocolsTool");
    expect(body).toMatch(/CONFIGURABLE_PROTOCOLS\.map\(/);
    expect(body).not.toMatch(/Object\.entries\(TEXT_PROTOCOL_LABELS\)/);
  });

  it("no preset the editor will not offer is recommended to the model", () => {
    // `gemini-generate` is still a preset and has no route that would ever
    // select it. The editor removed it from the picker; the tool must not put
    // it back in the model's hands.
    expect(CONFIGURABLE_PROTOCOLS).not.toContain("gemini-generate" as never);
    expect(Object.keys(TEXT_PROTOCOL_LABELS)).toContain("gemini-generate");
  });

  it("each protocol says which endpoint it governs and which toggle gates it", () => {
    // Without both, the model writes a rule for an interface nothing calls.
    const body = toolBody("listTextProtocolsTool");
    expect(body).toMatch(/clientPath/);
    expect(body).toMatch(/requiresFace/);
    expect(body).toMatch(/faces:/);
  });

  it("no count is written into prose anywhere the model reads it", () => {
    // "四个预设" outlived the fourth protocol and was corrected the same week in
    // the editor. A count in a sentence cannot be checked against the array.
    for (const [name, src] of [["tools.ts", TOOLS], ["deployment-notes.ts", NOTES]] as const) {
      expect(src, `${name} claims a number of protocols`).not.toMatch(/四(个|种|条)协议|四个预设/);
    }
  });
});

describe("the tester explains the call it actually made", () => {
  it("resolves the rule by surface rather than by list position", () => {
    // The test goes out through `proxyChatCompletion`, so `openai-chat` is the
    // surface. `readTextSpec` folded the list to whichever entry came first.
    expect(TEST_MODEL).toMatch(/specForSurface\(readTextSpecs\(provider\), "openai-chat"\)/);
    expect(TEST_MODEL).not.toMatch(/readTextSpec\(provider\)/);
  });

  it("names the rule it applied, so the panel can attribute the decisions", () => {
    expect(TEST_MODEL).toMatch(/governedBy/);
  });

  it("and says nothing when the OpenAI face is off", () => {
    // A face that is off means the request is never answered here, so a rule
    // attributed to this call would be a claim about something that did not run.
    // The selection is the check now: `findOpenAIProvidersForModel` is what
    // excludes those rows, so there is no second test of the flag to drift.
    expect(TEST_MODEL).toMatch(/findOpenAIProvidersForModel\(model\)/);
    expect(TEST_MODEL).toMatch(/unavailable/);
  });
});

describe("the surfaces line up", () => {
  it("every configurable protocol is a surface the gateway actually serves", () => {
    // The one invariant that made the assistant's four-preset list wrong: a
    // protocol with no route is a field that saves and does nothing.
    for (const p of CONFIGURABLE_PROTOCOLS) {
      expect(SURFACES.some((s) => s.id === p), `${p} is offered but not a surface`).toBe(true);
    }
    expect(SURFACES.length).toBe(CONFIGURABLE_PROTOCOLS.length);
  });
});
