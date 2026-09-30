/**
 * tests/unit/media-protocol-doc.test.ts
 *
 * `docs/模型适配协议/README.md` is rendered verbatim as the admin protocol
 * reference (/admin/docs/media), so an example that does not validate is worse
 * than no example: operators copy it, and the failure only shows up on a live
 * request.
 *
 * Every complete spec in the document is therefore parsed with the same
 * validator the admin panel uses, and the two video examples are additionally
 * checked for v1/v2 coexistence (the case specVersion 2 exists for).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMediaSpec, validateMediaSpecs, type MediaSpec } from "@/lib/media/spec";

const DOC = join(process.cwd(), "docs", "模型适配协议", "README.md");

/**
 * Strip `//` comments the way a JSONC reader must: not inside a string, and
 * respecting backslash escapes.
 */
function stripJsonc(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

interface Extracted {
  line: number;
  spec: MediaSpec;
  raw: Record<string, unknown>;
}

/** Every ```jsonc block that holds a complete spec object. */
function extractSpecs(markdown: string): { specs: Extracted[]; broken: string[] } {
  const specs: Extracted[] = [];
  const broken: string[] = [];
  for (const match of markdown.matchAll(/```jsonc\n([\s\S]*?)```/g)) {
    const line = markdown.slice(0, match.index).split("\n").length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(match[1]));
    } catch (err) {
      // Blocks that are fragments (a single mapping, a list of alternatives) are
      // not meant to be complete JSON; only flag a fragment that *looks* like a
      // full spec.
      if (/"specVersion"/.test(match[1])) {
        broken.push(`line ${line}: ${String(err).slice(0, 120)}`);
      }
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).specVersion !== undefined
    ) {
      specs.push({ line, spec: undefined as never, raw: parsed as Record<string, unknown> });
    }
  }
  return { specs, broken };
}

describe("protocol document", () => {
  const markdown = readFileSync(DOC, "utf8");
  const { specs, broken } = extractSpecs(markdown);

  it("has no example with a JSON syntax error", () => {
    expect(broken).toEqual([]);
  });

  it("contains complete spec examples", () => {
    expect(specs.length).toBeGreaterThanOrEqual(5);
  });

  it.each(specs.map((s) => [s.line, s] as const))(
    "the spec on line %i validates",
    (_line, entry) => {
      const parsed = parseMediaSpec(entry.raw);
      if (!parsed.ok) {
        throw new Error(`line ${entry.line}: ${parsed.errors.join("; ")}`);
      }
      expect(parsed.spec.specVersion).toBe(2);
    },
  );

  it("demonstrates v1/v2 coexistence with two video specs", () => {
    const videoSpecs = specs
      .map((s) => s.raw)
      .filter((raw) => (raw as { capability?: string }).capability === "video.generate");
    expect(videoSpecs.length).toBe(2);

    const result = validateMediaSpecs(videoSpecs);
    // This is the assertion that matters: if either example lost its `models`
    // field, the pair could no longer be saved on one provider.
    expect(result.errors).toEqual([]);

    const paths = videoSpecs.map((raw) => (raw as { transport: { path: string } }).transport.path);
    expect(paths).toContain("/v1/video_generation");
    expect(paths).toContain("/v2/video_generation");
  });

  it("declares specVersion 2 in the example of the two JSON blocks", () => {
    // §4 tells the operator to hand the models/specs blocks to an admin, so the
    // documented shape must not lead them astray.
    expect(markdown).toContain("specVersion 固定为 2");
  });

  it("documents every primitive the engine implements", () => {
    const engine = readFileSync(join(process.cwd(), "src", "lib", "media", "engine.ts"), "utf8");
    for (const primitive of [
      "$const",
      "$ifPresent",
      "$enum",
      "$mapSize",
      "$toString",
      "$dataUrl",
      "$file",
      "$firstPresent",
      "$from",
      "$merge",
      "$eq",
      "$fetch",
    ]) {
      // The engine must actually implement it …
      expect(engine, `engine is missing ${primitive}`).toContain(`"${primitive}" in record`);
      // … and the doc must teach it.
      expect(markdown, `doc does not document ${primitive}`).toContain(primitive);
    }
  });

  it("documents every transport capability the engine implements", () => {
    for (const [label, token] of [
      ["header mappings", '"headers"'],
      ["query mappings", '"query"'],
      ["{{model}} substitution", "{{model}}"],
      ["form-urlencoded bodies", "application/x-www-form-urlencoded"],
      ["sse response mode", "sse"],
      ["per-spec baseUrl", '"baseUrl"'],
    ] as const) {
      expect(markdown, `doc does not cover ${label}`).toContain(token);
    }
  });
});
