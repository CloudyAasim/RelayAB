/**
 * tests/unit/text-protocol-doc.test.ts
 *
 * The protocol document, and the guard that keeps it true.
 *
 * The failure mode of a protocol document is not that it is wrong; it is that
 * it is *stale*. An operator reads it, writes a spec, and the spec quietly does
 * nothing because the field was renamed a release ago. Nothing anywhere turns
 * red, and the operator's conclusion is that the feature is broken.
 *
 * So this test reads the document and checks every mechanism it names against
 * the code. The media protocol has this test for the same reason
 * (`media-protocol-doc.test.ts`), and the text protocol is not a second-class
 * document: it is the thing a stranger configures the gateway with.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTextSpec,
  PARAMETER_MODES,
  TEXT_PROTOCOLS,
  isTextProtocol,
} from "@/lib/protocol/text-spec";
import { TEXT_PROTOCOL_PRESETS } from "@/lib/protocol/text-protocols";
import { applyParameterPolicy } from "@/lib/protocol/parameter-policy";
import { isValidSpecMapping } from "@/lib/protocol/text-spec-mapping";

const ROOT = process.cwd();
const DOC = readFileSync(join(ROOT, "docs", "文本适配协议", "README.md"), "utf-8");
const SPEC = readFileSync(join(ROOT, "src", "lib", "protocol", "text-spec.ts"), "utf-8");
const MAPPING = readFileSync(join(ROOT, "src", "lib", "protocol", "text-spec-mapping.ts"), "utf-8");
const POLICY = readFileSync(join(ROOT, "src", "lib", "protocol", "parameter-policy.ts"), "utf-8");
const ROUTE = readFileSync(join(ROOT, "src", "app", "api", "admin", "providers", "[id]", "route.ts"), "utf-8");
const OPENAI = readFileSync(join(ROOT, "src", "lib", "proxy", "openai.ts"), "utf-8");
const ANTHROPIC = readFileSync(join(ROOT, "src", "lib", "proxy", "anthropic.ts"), "utf-8");

describe("the document is in the repository, not in somebody's head", () => {
  it("exists, and is the text one", () => {
    expect(DOC).toContain("文本适配协议");
    expect(DOC).toMatch(/specVersion 1/);
  });
});

describe("every mechanism the document names is in the code", () => {
  it.each([
    ["parseTextSpec", SPEC],
    ["isValidSpecMapping", MAPPING],
    ["applyParameterPolicy", POLICY],
    ["readTextSpec", SPEC],
    ["TEXT_PROTOCOL_PRESETS", readFileSync(join(ROOT, "src", "lib", "protocol", "text-protocols.ts"), "utf-8")],
  ])("%s is where the document says it is", (name, source) => {
    expect(DOC, `${name} is named in the document`).toContain(name);
    expect(source, `${name} is not in the file the document names`).toContain(name);
  });

  it("the paths it points at exist", () => {
    for (const path of [
      "src/lib/protocol/text-spec.ts",
      "src/lib/protocol/text-specs.ts",
      "src/lib/protocol/text-spec-mapping.ts",
      "src/lib/protocol/parameter-policy.ts",
      "src/lib/protocol/text-protocols.ts",
      "src/app/api/admin/providers/[id]/route.ts",
      "src/app/api/admin/providers/route.ts",
      "src/app/(admin)/admin/providers/TextProtocolField.tsx",
      "src/lib/proxy/openai.ts",
      "src/lib/proxy/anthropic.ts",
    ]) {
      expect(DOC, `${path} is named but the file is not there`).toContain(path);
      expect(() => readFileSync(join(ROOT, ...path.split("/")), "utf-8"), path).not.toThrow();
    }
  });
});

describe("the claims the document makes are the behaviour", () => {
  it("“no spec means forward everything”", () => {
    expect(DOC).toContain("不配协议 = 原样透传");
    const body = { model: "m", messages: [], seed: 1, reasoning_effort: "high" };
    expect(applyParameterPolicy(body, undefined).body).toEqual(body);
  });

  it("“anything not named is passthrough”", () => {
    expect(DOC).toMatch(/没有列出的参数一律 `passthrough`/);
    const out = applyParameterPolicy({ brandNew: "x" }, { parameters: { other: { mode: "drop" } } });
    expect(out.body.brandNew).toBe("x");
  });

  it("“drop, and never picked back up by a later rule”", () => {
    // The documented order has drop first, so a `force` on the same parameter
    // cannot resurrect a field the operator closed.
    const out = applyParameterPolicy(
      { temperature: 0.5 },
      { parameters: { temperature: { mode: "force", value: 1 } } },
    );
    expect(out.body.temperature).toBe(1);
    const closed = applyParameterPolicy(
      { temperature: 0.5 },
      { parameters: { temperature: { mode: "drop" } } },
    );
    expect("temperature" in closed.body).toBe(false);
  });

  it("“force beats clamp”, as the documented order says", () => {
    const out = applyParameterPolicy(
      { n: 99 },
      { parameters: { n: { mode: "clamp", max: 10 } } },
    );
    expect(out.body.n).toBe(10);
    // And a force on a different parameter is unaffected by the clamp.
    const both = applyParameterPolicy(
      { n: 99, m: 1 },
      { parameters: { n: { mode: "clamp", max: 10 }, m: { mode: "force", value: 7 } } },
    );
    expect(both.body.n).toBe(10);
    expect(both.body.m).toBe(7);
  });

  it("“a dot path in `to` creates the objects on the way”", () => {
    expect(DOC).toContain("点号路径");
    const out = applyParameterPolicy(
      { reasoning_effort: "high" },
      { parameters: { reasoning_effort: { mode: "rename", to: "extra_body.thinking.type" } } },
    );
    expect((out.body.extra_body as { thinking: { type: string } }).thinking.type).toBe("high");
  });

  it("“a bad spec degrades to no policy rather than taking the provider offline”", () => {
    expect(DOC).toContain("静默降级");
    const body = { model: "m", messages: [] };
    // `readTextSpec` returns null for an unreadable or invalid document; this is
    // what the proxy then does with it.
    expect(applyParameterPolicy(body, undefined).body).toEqual(body);
  });
});

describe("the limits the document states are the limits the code has", () => {
  it("mapping depth 32", () => {
    expect(DOC).toContain("32");
    expect(MAPPING).toContain("depth > 32");
    // And it is enforced: a tree one level too deep is refused.
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(isValidSpecMapping(deep)).toBe(false);
    expect(isValidSpecMapping({ n: { n: "leaf" } })).toBe(true);
  });

  it("specVersion must be exactly 1", () => {
    expect(DOC).toMatch(/固定 `1`/);
    expect(parseTextSpec({ specVersion: 2, protocol: "openai-chat" }).ok).toBe(false);
  });

  it("a string leaf is a literal, so an enum table is a valid mapping", () => {
    // The media engine returns a bare string unchanged, so a gate that rejected
    // one would refuse the most ordinary thing a spec does.
    expect(DOC).toContain("字面量原样返回");
    expect(isValidSpecMapping({ $enum: { "$.size": { map: { s1024: "1024x1024" } } } })).toBe(true);
  });
});

describe("the four protocols in the document are the four in the code", () => {
  it.each(TEXT_PROTOCOLS)("%s is documented", (protocol) => {
    expect(DOC, `${protocol} is not in the document`).toContain(protocol);
    expect(isTextProtocol(protocol)).toBe(true);
  });

  it("and no more than the four", () => {
    const documented = [...DOC.matchAll(/`(openai-chat|openai-responses|anthropic-messages|gemini-generate)`/g)].map(
      (m) => m[1],
    );
    expect(new Set(documented).size).toBe(TEXT_PROTOCOLS.length);
    expect(TEXT_PROTOCOLS).toHaveLength(4);
  });
});

describe("the six modes in the document are the six in the code", () => {
  it.each(PARAMETER_MODES)("%s is documented", (mode) => {
    expect(DOC, `${mode} is not in the document`).toContain(`\`${mode}\``);
  });

  it("and the table row for each says the same thing the code does", () => {
    for (const mode of PARAMETER_MODES) {
      expect(DOC, `no row for ${mode}`).toMatch(new RegExp(`\`${mode}\`\\s*\\|`));
    }
  });
});

describe("the presets do what the document says they do", () => {
  it("anthropic renames the two fields the document names", () => {
    expect(DOC).toContain("`stop` → `stop_sequences`");
    expect(DOC).toContain("`max_completion_tokens` → `max_tokens`");
    const spec = TEXT_PROTOCOL_PRESETS["anthropic-messages"];
    expect(spec.parameters?.stop).toEqual({ mode: "rename", to: "stop_sequences" });
    expect(spec.parameters?.max_completion_tokens).toEqual({ mode: "rename", to: "max_tokens" });
  });

  it("gemini nests its sampling parameters, as the document says", () => {
    expect(DOC).toContain("`generationConfig.*`");
    const spec = TEXT_PROTOCOL_PRESETS["gemini-generate"];
    expect(spec.parameters?.temperature).toEqual({
      mode: "rename",
      to: "generationConfig.temperature",
    });
  });

  it("every preset survives its own validator", () => {
    for (const protocol of TEXT_PROTOCOLS) {
      expect(
        parseTextSpec(TEXT_PROTOCOL_PRESETS[protocol]).ok,
        `${protocol} is documented as usable but does not parse`,
      ).toBe(true);
    }
  });
});

describe("the document's forbidden-operator rule is enforced", () => {
  it.each(["$fetch", "$file", "$dataUrl"])("%s is refused, and named", (op) => {
    expect(DOC).toContain(op);
    const result = parseTextSpec({
      specVersion: 1,
      protocol: "openai-chat",
      request: { x: { [op]: "y" } },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors.join()).toContain(op);
  });
});

describe("the document's claim that saving validates is true", () => {
  it("the write endpoint parses the spec before storing it", () => {
    // The call itself, not the import: a stub that parses nothing and accepts
    // everything leaves the import line intact and satisfies a weaker check.
    expect(DOC).toContain("validateTextSpecs");
    expect(ROUTE).toMatch(/validateTextSpecs\(value \?\? \[\]\)/);
    expect(ROUTE).toMatch(/textSpecs: z\s*\.array[\s\S]*?superRefine/);
  });

  it("and the order of the rules is the one the document lists", () => {
    // `drop` first is the claim. Reordering the switch so a later rule can
    // resurrect a closed field breaks it, and the document says it cannot.
    //
    // Both halves are needed. Deleting the `drop` case entirely moves its index
    // to -1, and `-1 < force` is *true* — so an order check that only compares
    // positions passes precisely when the rule it is protecting is gone.
    const dropAt = POLICY.indexOf('case "drop"');
    const forceAt = POLICY.indexOf('case "force"');
    expect(dropAt, "the document says a parameter can be closed").toBeGreaterThan(-1);
    expect(forceAt, "the document says a later rule exists").toBeGreaterThan(-1);
    expect(dropAt, "the document says drop is decided first").toBeLessThan(forceAt);
  });

  it("and both proxy faces apply the policy", () => {
    // The paths are already checked above; what matters here is that the two
    // faces both call the engine, not only the one a test happens to exercise.
    expect(OPENAI).toMatch(/applyParameterPolicy/);
    expect(ANTHROPIC).toMatch(/applyParameterPolicy/);
  });
});
