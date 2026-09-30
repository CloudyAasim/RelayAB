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
      expect(parsed.spec.specVersion).toBe(1);
    },
  );

  it("demonstrates two specs of one capability coexisting", () => {
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

  it("declares specVersion 1 in the example of the two JSON blocks", () => {
    // §4 tells the operator to hand the models/specs blocks to an admin, so the
    // documented shape must not lead them astray.
    expect(markdown).toContain("specVersion 固定为 1");
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

/**
 * §0 is the section an AI reads. If it drifts from the code, every spec written
 * from it is wrong — so the quick reference is checked field-by-field against
 * the TypeScript types rather than trusted.
 */
describe("§0 quick reference is in sync with the code", () => {
  const markdown = readFileSync(DOC, "utf8");
  const section0 = markdown.split("## 1. 五分钟看懂")[0];

  /** Field names declared in a `export interface X { … }` block. */
  function interfaceFields(source: string, name: string): string[] {
    const start = source.indexOf(`export interface ${name} {`);
    if (start < 0) return [];
    const body = source.slice(start);
    const fields: string[] = [];
    for (const line of body.split("\n").slice(1)) {
      if (line.startsWith("}")) break;
      const match = /^\s{2}(\w+)\??:/.exec(line);
      if (match) fields.push(match[1]);
    }
    return fields;
  }

  const specSource = readFileSync(join(process.cwd(), "src", "lib", "media", "spec.ts"), "utf8");

  it("is actually present", () => {
    expect(section0).toContain("## 0. 给 AI 的操作说明");
    expect(section0.length).toBeGreaterThan(3000);
  });

  it.each(interfaceFields(specSource, "MediaSpec"))(
    "§0.3.1 documents the MediaSpec field %s",
    (field) => {
      expect(section0, `§0 quick reference is missing MediaSpec.${field}`).toContain(
        `\`${field}\``,
      );
    },
  );

  it.each(interfaceFields(specSource, "MediaTransport"))(
    "§0.3.2 documents the MediaTransport field %s",
    (field) => {
      expect(section0, `§0 quick reference is missing MediaTransport.${field}`).toContain(
        `\`${field}\``,
      );
    },
  );

  it.each(interfaceFields(specSource, "MediaErrorRule"))(
    "§0.3.5 documents the MediaErrorRule field %s",
    (field) => {
      expect(section0, `§0 quick reference is missing MediaErrorRule.${field}`).toContain(
        `\`${field}\``,
      );
    },
  );

  it.each(interfaceFields(specSource, "MediaLimits"))(
    "§0.3.1 documents the MediaLimits field %s",
    (field) => {
      expect(section0, `§0 quick reference is missing MediaLimits.${field}`).toContain(
        `\`${field}\``,
      );
    },
  );

  it("documents every capability", () => {
    for (const capability of [
      "image.generate",
      "image.edit",
      "video.generate",
      "audio.tts",
      "audio.stt",
      "music.generate",
    ]) {
      expect(section0, `§0.3.1 does not list capability ${capability}`).toContain(capability);
    }
  });

  it("documents every response-contract key", () => {
    for (const key of [
      "items",
      "successCount",
      "taskId",
      "status",
      "text",
      "errorCode",
      "errorMessage",
    ]) {
      expect(section0, `§0.3.4 does not list response.${key}`).toContain(`\`${key}\``);
    }
  });

  it("documents every item encoding", () => {
    for (const encoding of ["plain", "base64", "hex", "dataUrl"]) {
      expect(section0, `§0.3.4 does not list encoding ${encoding}`).toContain(encoding);
    }
  });

  it("documents every async.poll field", () => {
    for (const key of [
      "submitTaskId",
      "method",
      "path",
      "intervalMs",
      "timeoutMs",
      "statusPath",
      "statusMap",
      "successValues",
      "failureValues",
      "statusMatch",
    ]) {
      expect(section0, `§0.3.6 does not document async.${key}`).toContain(`\`${key}\``);
    }
  });

  it("gives the AI the three-step habit that catches real incidents", () => {
    // Every spec written from a version of this doc that lacked these
    // instructions had a live bug that validation could not catch.
    for (const [label, token] of [
      ["required-fields step", "required:"],
      ["error-status step", "responses:"],
      ["state-enum step", "statusMap"],
      ["untrusted-encoding rule", "encoding"],
      ["second-call rule", "$fetch"],
      ["idempotency warning", "不重试"],
    ] as const) {
      expect(section0, `§0 is missing the ${label}`).toContain(token);
    }
  });

  it("shows the two-JSON-block output format", () => {
    expect(section0).toContain("【第一块：models");
    expect(section0).toContain("【第二块：specs");
  });

  it("tells the AI to run the judge before delivering", () => {
    expect(section0).toContain("pnpm spec-check");
    expect(section0).toContain("没跑过判官就不要交付");
  });
});

/**
 * §0.3 documents the engine's *exact* semantics, and `scripts/spec-check.ts` is
 * a second implementation of them. If either drifts from the engine, every spec
 * written against the document is subtly wrong, so the load-bearing invariants
 * are asserted here rather than trusted.
 */
describe("§0.3 engine semantics section stays in sync", () => {
  const markdown = readFileSync(DOC, "utf8");
  const section = markdown.slice(
    markdown.indexOf("### 0.3 引擎怎么跑的"),
    markdown.indexOf("### 0.4 协议速查"),
  );
  const engine = readFileSync(join(process.cwd(), "src", "lib", "media", "engine.ts"), "utf8");

  it("exists and is substantial", () => {
    expect(section.length).toBeGreaterThan(3000);
  });

  it.each([
    ["the full call order", "一次调用的完整顺序"],
    ["mapping evaluation order", "applyMapping(node, scope)"],
    ["the $firstPresent object trap", "$firstPresent` 只对标量可靠"],
    ["key-dropping rules", "键被丢弃的规则"],
    ["item normalisation", "上游响应怎么变成 items"],
    ["hex edge cases", "不是合法 hex 就原样透传"],
    ["poll classification", "异步轮询的判定"],
    ["$fetch limits", "$fetch` 的展开时机与限制"],
    ["empty-result handling", "空结果的两种情况"],
    ["scope construction", "buildMediaScope"],
    ["url/header precedence", "URL 与 header 的优先级"],
    ["explicit non-goals", "引擎明确不做的事"],
  ])("documents %s", (_label, heading) => {
    expect(section).toContain(heading);
  });

  it.each([
    ["MAX_FETCH_MARKERS", /MAX_FETCH_MARKERS = 8/],
    ["FETCH_TIMEOUT_MS", /FETCH_TIMEOUT_MS = 30_000/],
  ])("keeps the engine constant %s", (_label, pattern) => {
    expect(engine).toMatch(pattern);
  });

  it.each([
    ["the fetch cap", "最多 8 个"],
    ["the fetch timeout", "总超时 **30s**"],
    ["the poll interval default", "intervalMs"],
  ])("states %s in the prose", (_label, phrase) => {
    expect(section).toContain(phrase);
  });

  it("agrees with the validator on the serverless ceiling", () => {
    const specSource = readFileSync(join(process.cwd(), "src", "lib", "media", "spec.ts"), "utf8");
    // The ceiling is enforced in the validator; the document must not claim a
    // different number or an operator will size their timeouts off the doc.
    expect(specSource).toContain("300_000");
    expect(markdown).toContain("300000");
  });

  it("documents the fallback status vocabulary the engine ships", () => {
    // These defaults are the reason an unlabelled success still converges.
    expect(section).toContain('""');
    expect(section).toContain("task_timeout");
  });

  it("still names the real engine entry points", () => {
    for (const symbol of ["buildMediaScope", "applyMapping", "classifyStatus"]) {
      expect(engine, `engine no longer defines ${symbol}`).toContain(symbol);
    }
  });
});
