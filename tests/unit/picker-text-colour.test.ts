/**
 * tests/unit/picker-text-colour.test.ts
 *
 * White text on a white background, in the one place that matters.
 *
 * The model picker's rows looked empty. Not broken-looking, not erroring —
 * empty-looking, because a row is a checkbox and a border, and the thing beside
 * them was rendered in a colour that resolved to white against the row's
 * white. Every assertion in the repository passed, the build was green, and the
 * whole feature was unusable to the one person it was written for.
 *
 * It happened because the model id was the only text node in the modal without
 * an explicit colour: the heading, the description and the buttons all stated
 * theirs, and this one inherited. And it is the *only* text in its row whenever
 * a vendor publishes no numbers — which is most rows, most of the time — so the
 * one element that forgot was also the one that carried the whole row.
 *
 * Inherited colour is a decision somebody has to make, and leaving it out is not
 * a decision. So it is stated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PICKER = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "providers", "ModelPickerModal.tsx"),
  "utf-8",
);

describe("every piece of text in the picker states its colour", () => {
  it("the model id, which is the only text a sparse row has", () => {
    // Not `toContain("text-xs")` — that would match the spacing class and pass
    // on the broken version. The colour has to be on the same element.
    expect(PICKER).toMatch(
      /<span className="block font-mono text-xs text-foreground">\{e\.id\}<\/span>/,
    );
    expect(PICKER, "the model id still has no colour of its own").not.toMatch(
      /<span className="block font-mono text-xs">\{e\.id\}<\/span>/,
    );
  });

  it("and the wrapper, so a future row does not inherit it again", () => {
    expect(PICKER).toMatch(/<span className="min-w-0 flex-1 text-foreground">/);
  });

  it("and no other text node in the modal is left to inheritance", () => {
    // Everything from the component's first `return` to the end of the file —
    // which is the JSX and nothing else, so the import list and the type
    // declarations do not drown the signal.
    const jsx = PICKER.slice(PICKER.indexOf("export function ModelPickerModal"));
    const textSpans = [...jsx.matchAll(/<span className="([^"]*)"/g)].map((m) => m[1]);
    expect(textSpans.length, "no spans found — the slice is wrong").toBeGreaterThan(0);
    const unstated = textSpans.filter((c) => !/text-(foreground|muted-foreground|destructive)/.test(c));
    expect(unstated, `these spans state no colour: ${unstated.join(" | ")}`).toEqual([]);
  });
});
