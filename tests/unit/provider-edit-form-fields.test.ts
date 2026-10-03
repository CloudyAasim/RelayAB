/**
 * tests/unit/provider-edit-form-fields.test.ts
 *
 * Advanced mode was hiding the form.
 *
 * The provider editor has two modes, and the one that is supposed to add
 * parameter rules instead replaced the form. The branch read
 *
 *   {mode === "advanced" ? <TextProtocolField/> : ( …name, base URL, key, models… )}
 *
 * so switching to advanced took the name, the base URL, the API key, the
 * priority and the whole model mapping off the screen. There was then no way to
 * enter a key while in the mode that was supposed to be configuring the vendor
 * in more depth — the copy above it said "saving writes both together", which
 * described a form that did not exist.
 *
 * The create form was already correct: its fields sit outside the branch, and
 * only the protocol list is conditional. That asymmetry is what made this easy
 * to miss — the behaviour was right in one place and broken in the other, and
 * the existing guard explicitly allowed the broken spelling.
 *
 * The mode is now additive everywhere: the same fields in both, plus the
 * protocol list in advanced. These tests hold that line, and hold the interface
 * selector to exactly one rendering per form — it was rendered twice in the
 * edit modal, the second copy without the `configured` prop, so the orphan
 * warnings vanished in the one place you configure a face.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const EDIT = read("src", "app", "(admin)", "admin", "providers", "ProviderActions.tsx");
const CREATE = read("src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx");
const FIELD = read("src", "app", "(admin)", "admin", "providers", "TextProtocolField.tsx");

const FORMS = [
  ["edit", EDIT],
  ["create", CREATE],
] as const;

/** Count a JSX tag, with a boundary so `<ProviderFacesFieldGone` cannot pass. */
const occurrences = (src: string, tag: string): number =>
  (src.match(new RegExp(`${tag}[\\s>]`, "g")) ?? []).length;

describe("the mode switch adds detail, it does not replace the form", () => {
  it.each(FORMS)("%s: no mode branch that wraps the provider's own fields", (_name, src) => {
    // A ternary is the tell: one side of it is a whole form, and whatever is
    // on the other side does not exist. The additive spelling is `&&`.
    expect(
      src.includes('mode === "advanced" ?'),
      "a mode ternary hides one branch of the form; use `&&` so advanced only adds",
    ).toBe(false);
  });

  it.each(FORMS)("%s: the API key field is never conditional", (_name, src) => {
    const keyAt = src.search(/admin\.providers\.create\.apiKey/);
    expect(keyAt, "no API key field in this form").toBeGreaterThan(-1);

    // The one conditional in the form is the protocol list. The key must not
    // sit inside any conditional at all.
    const branchStart = src.indexOf('mode === "advanced"');
    expect(branchStart, "no mode branch in this form").toBeGreaterThan(-1);
    // The list opens and closes within a few lines; the key field cannot be
    // inside it.
    const listEnd = src.indexOf("/>", src.indexOf("<TextProtocolField"));
    expect(
      keyAt < branchStart || keyAt > listEnd,
      "the API key field is inside the advanced branch, so advanced mode cannot enter one",
    ).toBe(true);
  });

  it.each(FORMS)("%s: the interface selector renders exactly once", (_name, src) => {
    // It was rendered twice in the edit modal, and the second copy was missing
    // `configured`, so the warnings about rules for a switched-off face
    // disappeared in the very form you use to switch a face.
    expect(occurrences(src, "<ProviderFacesField")).toBe(1);
  });

  it.each(FORMS)("%s: the protocol list appears only in advanced mode", (_name, src) => {
    expect(src).toMatch(/mode === "advanced" &&/);
    const at = src.search(/<TextProtocolField/);
    expect(at, "no protocol list in this form").toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, at - 200), at)).toMatch(/mode === "advanced" &&/);
  });
});

describe("the protocol list follows the face switches", () => {
  it("the add-buttons are filtered by the face, not just by what is used", () => {
    // Without this, switching the OpenAI face off still offered to add
    // `/v1/chat/completions` and `/v1/responses` — two controls in one form
    // answering "which interfaces does this provider speak" with opposite
    // answers, and nothing on screen connected them.
    //
    // Anchored on `.map(` so it pins the add-buttons specifically: the "is
    // anything left to add" message below them uses the same predicate, and a
    // looser match would keep passing if only the buttons lost the filter.
    expect(FIELD).toMatch(
      /CONFIGURABLE_PROTOCOLS\.filter\(\(p\) => !used\.has\(p\) && faceOn\(p\)\)\.map\(/,
    );
  });

  it("an entry whose face is off is marked, not silently offered as live", () => {
    expect(FIELD).toMatch(/faceOffBadge/);
    // Kept, not dropped: switching a face off is not a reason to lose typing.
    expect(FIELD).not.toMatch(/faceOn\(protocol\)[\s\S]{0,200}remove\(/);
  });

  it("both forms pass their live faces in", () => {
    for (const [name, src] of FORMS) {
      expect(src, `${name} does not pass faces`).toMatch(
        /faces=\{\{ openai: faces\.openaiEnabled, anthropic: faces\.anthropicEnabled \}\}/,
      );
    }
  });
});
