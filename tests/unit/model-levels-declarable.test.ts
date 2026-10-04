/**
 * tests/unit/model-levels-declarable.test.ts
 *
 * "Which levels does this model take" has to be answerable by writing it down.
 *
 * It used to be reachable only by scraping a vendor's model list — which makes
 * it unreachable for every vendor that does not publish one, and most do not.
 * So the answer for the models that matter was whatever this system guessed.
 *
 * The levels are a field on the model configuration now, beside the context
 * window and the output cap, written the way the vendor's documentation writes
 * them and passed to the wire exactly as typed. The probe can fill it; the
 * operator can, and that is the point.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelEntrySchema } from "@/app/api/admin/model-config/route";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const FORM = read("src", "app", "(admin)", "admin", "model-notes", "ModelConfigForm.tsx");
const ROW = read("src", "lib", "admin", "model-config.ts");
const API = read("src", "app", "api", "admin", "model-config", "route.ts");
const DICT = read("src", "lib", "i18n", "dict.ts");

describe("the levels are a field on the model configuration", () => {
  it("and the form has one, next to the window and the cap", () => {
    expect(FORM, "the form has no field for them").toContain(
      "admin.providers.create.reasoningLevels",
    );
    expect(FORM, "the field is not bound to the row").toMatch(
      /reasoningLevels: parseLevelList\(e\.target\.value\)/,
    );
    // It reads back as a list, not as the raw string that was typed.
    expect(FORM).toMatch(/value=\{\(row\.reasoningLevels \?\? \[\]\)\.join\(", "\)\}/);
  });

  it("split on what a vendor's documentation actually uses", () => {
    // Comma, full-width comma, space — and the list keeps its order, because
    // "low to high" is the order the vendor wrote them in.
    expect(FORM).toMatch(/function parseLevelList\(raw: string\): string\[\]/);
    expect(FORM).toMatch(/raw\.split\(\/\[,，\\s\]\+\/\)/);
    // No case folding and no validation: a vendor that writes `XHIGH` or
    // `THINK_HIGH` means it, and the value goes on the wire as typed. Scoped to
    // the function, because the file has a `toLowerCase` of its own for
    // somewhere else entirely.
    const parser = FORM.slice(FORM.indexOf("function parseLevelList"));
    expect(parser.slice(0, 600), "the levels are normalised on the way in").not.toMatch(
      /toLowerCase\(\)/,
    );
    expect(parser.slice(0, 600)).not.toMatch(/ASSISTANT_REASONING_EFFORTS/);
  });

  it("the row carries it, and an older row simply has none", () => {
    expect(ROW, "the row type has no levels").toMatch(/reasoningLevels: string\[\];/);
    expect(ROW, "an older config has no levels to read").toMatch(
      /reasoningLevels: cfg\?\.reasoningLevels \?\? \[\]/,
    );
  });

  it("the API accepts it and keeps it across an edit that did not mention it", () => {
    // Accepting a list, and filtering it, checked by handing one to the schema
    // the route actually parses with. Both used to be asserted by matching the
    // route's own text, which is a claim about a file rather than about the
    // endpoint — and the shape now lives in one shared schema that the route
    // imports, so there is nothing of it left in this file to match.
    const parsed = ModelEntrySchema.safeParse({
      providerId: "p",
      upstreamId: "u",
      clientId: "c",
      // The shape that really happened: a parser that read the keys of the
      // vendor's refusal and called them the list of levels the model accepts.
      reasoningLevels: ["http_code", "request_id", "low", "medium", "high"],
    });
    expect(parsed.success, "the route will not take a list").toBe(true);
    if (parsed.success) {
      expect(parsed.data.reasoningLevels).toEqual(["low", "medium", "high"]);
    }
    // Merging, so an edit of some other field must not quietly drop them —
    // the failure that makes a declared configuration look unset.
    expect(API).toMatch(
      /reasoningLevels: entry\.reasoningLevels \?\? existing\?\.reasoningLevels \?\? \[\]/,
    );
  });

  it("and the label says what the field is for", () => {
    expect(DICT).toContain("admin.providers.create.reasoningLevels");
    expect(DICT).toContain("admin.providers.create.reasoningLevelsHint");
  });
});
