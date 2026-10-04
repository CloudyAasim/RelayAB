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
    expect(API, "the route will not take a list").toMatch(
      /reasoningLevels: z[\s\S]{0,120}?\.array\(z\.string\(\)\.min\(1\)\.max\(64\)\)/,
    );
    // …and it filters on the way in. A level is a value the model accepts; the
    // field names in the error that said so are not, and nine models here carried
    // two of them until this was written.
    expect(API, "envelope field names can be stored as levels").toMatch(
      /\.transform\(\(levels\) => sanitizeLevelList\(levels\)\)/,
    );
    // Merging, so an edit of some other field must not quietly drop them —
    // the failure that makes a declared configuration look unset.
    expect(API).toMatch(/reasoningLevels: entry\.reasoningLevels \?\? existing\?\.reasoningLevels \?\? \[\]/);
  });

  it("and the label says what the field is for", () => {
    expect(DICT).toContain("admin.providers.create.reasoningLevels");
    expect(DICT).toContain("admin.providers.create.reasoningLevelsHint");
  });
});
