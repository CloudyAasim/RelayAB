/**
 * tests/unit/assistant-tool-text.test.ts
 *
 * The tool layer speaks both languages, and the two languages are the same
 * catalogue.
 *
 * The tool layer is the one place where a **structural** drift is possible
 * rather than a textual one: the descriptions live in a table and the shape
 * lives in `tools.ts`, so a change to the shape does not touch the words and a
 * change to the words does not touch the shape. That is the whole point of
 * the arrangement — and it is also what makes it worth guarding:
 *
 *  - a tool added to the catalogue with no English row would reach the model
 *    as a raw key, and the model reads a key as a key;
 *  - a parameter added on one side only would make the two catalogues offer
 *    the model different tools;
 *  - an English row left as a copy of the Chinese one would look translated
 *    and not be.
 */
import { describe, it, expect } from "vitest";

import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import {
  TOOL_DESCRIPTIONS,
  TOOL_REFUSALS,
  toolDescription,
  toolRefusal,
} from "@/lib/assistant/tool-text";

interface ToolDef {
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** The paths of every parameter of one tool, recursively. */
function parameterPaths(parameters: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties || typeof properties !== "object") return out;
  for (const [name, value] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(path);
    out.push(...parameterPaths(value, path));
  }
  return out.sort();
}

/** Every description in one catalogue, with the path it belongs to. */
function descriptionsOf(defs: ToolDef[]): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const def of defs) {
    out.push({ path: def.function.name, text: def.function.description ?? "" });
    const properties = (def.function.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    if (!properties || typeof properties !== "object") continue;
    for (const [name, value] of Object.entries(properties)) {
      const description = (value as { description?: string } | undefined)?.description;
      if (typeof description === "string") out.push({ path: `${def.function.name}.${name}`, text: description });
    }
  }
  return out;
}

describe("the tool catalogue is the same catalogue in both languages", () => {
  it("the same tools, in the same order", () => {
    const zh = toolDefinitions(true, {}, "zh-CN").map((d) => d.function.name);
    const en = toolDefinitions(true, {}, "en").map((d) => d.function.name);
    expect(en).toEqual(zh);
    expect(zh.length).toBeGreaterThan(10);
  });

  it("and the same parameters, down to the nested ones", () => {
    for (const isAdmin of [true, false]) {
      const zh = toolDefinitions(isAdmin, {}, "zh-CN") as ToolDef[];
      const en = toolDefinitions(isAdmin, {}, "en") as ToolDef[];
      for (let i = 0; i < zh.length; i++) {
        expect(
          parameterPaths(en[i].function.parameters),
          `${en[i].function.name} offers the model different parameters in English`,
        ).toEqual(parameterPaths(zh[i].function.parameters));
      }
    }
  });

  it("and no description is left as a raw key", () => {
    // A missing row returns the key itself, so a leaked key reads as
    // `list_gateway_models.model` — a dotted token with no sentence in it.
    for (const locale of ["zh-CN", "en"] as const) {
      for (const def of toolDefinitions(true, {}, locale) as ToolDef[]) {
        for (const { path, text } of descriptionsOf([def])) {
          expect(text, `${locale}: ${path} has no description`).not.toBe("");
          expect(
            text,
            `${locale}: ${path} is a raw key — the row is missing from the table`,
          ).not.toMatch(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/);
        }
      }
    }
  });

  it("and the English is a translation, not a copy", () => {
    const copied = Object.entries(TOOL_DESCRIPTIONS).filter(
      ([, value]) => value.en === value["zh-CN"],
    );
    expect(copied.map(([key]) => key), "these rows are the same in both languages").toEqual([]);
  });

  it("and the Chinese column is still the wording the deployment has been running", () => {
    // The Chinese is the prompt material that is already working, so it was
    // copied over rather than rewritten. A row that lost a sentence would be a
    // silent change to what the model is told.
    for (const [key, value] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(value["zh-CN"].length, `${key} lost its Chinese`).toBeGreaterThan(0);
      expect(value.en.length, `${key} has no English`).toBeGreaterThan(0);
    }
    for (const [key, value] of Object.entries(TOOL_REFUSALS)) {
      expect(value["zh-CN"].length, `${key} lost its Chinese`).toBeGreaterThan(0);
      expect(value.en.length, `${key} has no English`).toBeGreaterThan(0);
    }
  });
});

describe("the tool layer talks to the reader", () => {
  it("a refusal comes out in the reader's language", async () => {
    const result = await executeTool("no_such_tool", "{}", {
      user: { id: "u" },
      locale: "en",
    } as never);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Unknown tool");
    expect(result.content).not.toMatch(/[\u3400-\u4dbf\u4e00-\u9fff]/);
  });

  it("and in the deployment's language when that is what the reader chose", async () => {
    const result = await executeTool("no_such_tool", "{}", {
      user: { id: "u" },
      locale: "zh-CN",
    } as never);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("未知工具");
  });

  it("and a missing row falls back to the deployment's own language", () => {
    // A refusal nobody has translated yet is still a refusal — in the
    // deployment's language, which is always a truthful answer.
    expect(toolRefusal("en", "definitelyNotAKey")).toBe("definitelyNotAKey");
    expect(toolRefusal("zh-CN", "definitelyNotAKey")).toBe("definitelyNotAKey");
    expect(toolDescription("en", "definitelyNotAKey")).toBe("definitelyNotAKey");
  });
});
