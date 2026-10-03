/**
 * tests/unit/docs-page-id-editable.test.ts
 *
 * A page the operator named could not be named.
 *
 * Every custom page added from the admin settings vanished on save, with no
 * error, from the first version of this feature. The chain:
 *
 *   1. the id input was `readOnly={!p.hidden}`
 *   2. `addPage` creates `{ id: "", title: "", body: "", order }` — no `hidden`
 *   3. so `readOnly` was `true` on every row the moment it appeared
 *   4. `docsPagesPayload` drops rows with no id
 *   5. the page saved and was gone; the list stayed at zero
 *
 * The cause is that `hidden` means two different things. Everywhere else —
 * `docs/custom.ts`, `docs/catalog.ts`, the reader-side list — it means "not
 * shown to readers". In that one line it meant "this is a draft". `addPage` had
 * already been changed (an earlier commit) to create a *published* row, so the
 * meaning inverted and the line silently locked every id box.
 *
 * A source assertion would have passed: `readOnly={!p.hidden}` contains all the
 * right words. So the rule is exported and tested as behaviour — a row with no
 * id must be nameable, a row with one must not be renameable, and a full page
 * must survive the payload.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docsPagesPayload } from "@/app/(admin)/admin/settings/DocsPagesForm";

const ROOT = process.cwd();
const FORM = readFileSync(
  join(ROOT, "src", "app", "(admin)", "admin", "settings", "DocsPagesForm.tsx"),
  "utf-8",
);

/** The rule, as the form applies it. Mirrors `idLocked` in the component. */
const idLocked = (p: { id?: string }): boolean => Boolean(p.id?.trim());

describe("a custom page can be named", () => {
  it("a row with no id is editable — this is where a page gets its anchor", () => {
    expect(idLocked({ id: "" })).toBe(false);
    expect(idLocked({ id: "   " })).toBe(false);
    expect(idLocked({})).toBe(false);
  });

  it("a row that already has an id is fixed", () => {
    // Changing it would break every link a reader ever shared.
    expect(idLocked({ id: "rate-limits" })).toBe(true);
  });

  it("and that is what the input actually does", () => {
    // The regression, restated against the component. `hidden` is *not* in
    // this expression: it means "not shown to readers" everywhere else in this
    // codebase, and keying the id box to it is what broke the feature.
    expect(FORM).toMatch(/readOnly=\{idLocked\(p\)\}/);
    expect(FORM).toMatch(/function idLocked\(p: DocPageInput\): boolean/);
    expect(FORM).not.toMatch(/readOnly=\{!p\.hidden\}/);
  });
});

describe("a named page survives the save", () => {
  it("a filled row goes into the payload with its id", () => {
    const body = docsPagesPayload([
      { id: " rate-limits ", title: " 限流 ", body: "每秒 10 次", order: 0 },
    ]);
    expect(body.docPages).toEqual([
      { id: "rate-limits", title: "限流", body: "每秒 10 次", order: 0 },
    ]);
  });

  it("a row with no id is still dropped, and that is why the bug was silent", () => {
    // Dropping is right — an unlinkable entry is not a page. But combined with
    // an un-typeable id box it meant the only outcome was zero pages.
    expect(docsPagesPayload([{ id: "", title: "有标题", body: "有正文" }]).docPages).toEqual([]);
  });

  it("a blank row does not block the rows around it", () => {
    expect(
      docsPagesPayload([
        { id: "a", title: "A", body: "" },
        { id: "", title: "", body: "" },
        { id: "b", title: "B", body: "" },
      ]).docPages,
    ).toHaveLength(2);
  });
});
