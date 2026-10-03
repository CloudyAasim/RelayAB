/**
 * tests/unit/admin-settings-split.test.ts
 *
 * Three forms, three buttons, one settings table.
 *
 * They were one component with one button over the custom pages, the site copy
 * and the per-model notes. Two consequences, and the second is the one that
 * loses data:
 *
 *  - saving anything saved everything, so the button under the field you were
 *    looking at did not obviously govern the fields above it;
 *  - worse, each save rewrote *all three* from whatever the form was holding,
 *    including fields a half-finished edit had left blank.
 *
 * The endpoint only writes the keys present in the body, so the fix is entirely
 * in what each form sends. That is what these tests pin — the payload builders
 * are exported for exactly this reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docsPagesPayload } from "@/app/(admin)/admin/settings/DocsPagesForm";
import { docsSitePayload } from "@/app/(admin)/admin/settings/DocsSiteForm";
import { modelNotesPayload } from "@/app/(admin)/admin/model-notes/ModelNotesForm";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PAGES = read("src", "app", "(admin)", "admin", "settings", "DocsPagesForm.tsx");
const SITE = read("src", "app", "(admin)", "admin", "settings", "DocsSiteForm.tsx");
const NOTES = read("src", "app", "(admin)", "admin", "model-notes", "ModelNotesForm.tsx");
const SETTINGS_PAGE = read("src", "app", "(admin)", "admin", "settings", "page.tsx");
const NOTES_PAGE = read("src", "app", "(admin)", "admin", "model-notes", "page.tsx");
const NAV = read("src", "components", "layouts", "AuthenticatedLayout.tsx");

describe("each form sends only its own fields", () => {
  it("the pages form sends docPages and nothing else", () => {
    expect(Object.keys(docsPagesPayload([{ id: "a", title: "A", body: "x" }]))).toEqual(["docPages"]);
  });

  it("the site form sends the site fields and nothing else", () => {
    const keys = Object.keys(
      docsSitePayload({
        siteName: "n",
        siteDescription: "d",
        announcement: "a",
        supportContact: "c",
        publicCatalog: true,
      }),
    );
    expect(keys.sort()).toEqual(
      ["announcement", "publicCatalog", "siteDescription", "siteName", "supportContact"].sort(),
    );
  });

  it("the model notes form sends modelNotes and nothing else", () => {
    expect(Object.keys(modelNotesPayload({ m1: { displayName: "X" } }))).toEqual(["modelNotes"]);
  });

  it("so saving one cannot rewrite the other two", () => {
    // The behaviour under test, stated directly: each payload must not mention
    // the other forms' keys. The endpoint writes only what it is given, so a
    // form that sends `modelNotes` while saving the site name is the bug.
    const pages = JSON.stringify(docsPagesPayload([{ id: "a", title: "A", body: "x" }]));
    const site = JSON.stringify(docsSitePayload({ siteName: "n" }));
    const notes = JSON.stringify(modelNotesPayload({ m1: { note: "n" } }));

    expect(pages).not.toMatch(/modelNotes|siteName|publicCatalog|announcement|supportContact/);
    expect(site).not.toMatch(/modelNotes|docPages/);
    expect(notes).not.toMatch(/docPages|siteName|publicCatalog|announcement|supportContact/);
  });
});

describe("each form has its own save", () => {
  it("three buttons, not one", () => {
    const buttons = [PAGES, SITE, NOTES].filter((f) => f.includes("admin.docsSettings.save"));
    expect(buttons).toHaveLength(3);
  });

  it("and the combined form is gone", () => {
    // It cannot merely be unused: a component that still writes all three keys
    // from one form is the defect, whatever imports it.
    expect(() => read("src", "app", "(admin)", "admin", "settings", "DocsSettingsForm.tsx")).toThrow();
  });

  it("they all go through one helper, so none of them grew its own error handling", () => {
    for (const f of [PAGES, SITE, NOTES]) {
      expect(f, "a form that posts by hand").toMatch(/useSettingsSave/);
    }
    const helper = read("src", "components", "admin", "useSettingsSave.ts");
    expect(helper).toMatch(/router\.refresh\(\)/);
    expect(helper).toMatch(/setMessage/);
  });
});

describe("the model notes are their own page", () => {
  it("a route, at the same level as the system settings", () => {
    expect(NOTES_PAGE).toMatch(/export default async function ModelNotesPage/);
    expect(NAV).toMatch(/href: "\/admin\/model-notes"/);
    // A sibling, not a child: it is not reachable only through the settings page.
    expect(NAV).not.toMatch(/href: "\/admin\/settings\/model-notes"/);
  });

  it("listed next to the settings, not buried under it", () => {
    const at = NAV.indexOf('href: "/admin/model-notes"');
    const settings = NAV.indexOf('href: "/admin/settings"');
    expect(at).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(-1);
    expect(Math.abs(at - settings)).toBeLessThan(400);
  });

  it("and gone from the system settings page", () => {
    expect(SETTINGS_PAGE).not.toMatch(/ModelNotesForm/);
    expect(SETTINGS_PAGE).not.toMatch(/modelNotes/);
  });

  it("it still gets its ids from the live catalogue, not from memory", () => {
    // A note on a model id that does not exist renders on nothing, so the
    // editor has to offer the ones that do.
    expect(NOTES_PAGE).toMatch(/cachedBuildModelCatalog/);
  });
});

describe("what the notes form still refuses to do", () => {
  it("there is no field for a fact", () => {
    // Context window, price, upstream: read live from the provider table, so a
    // deployment cannot publish a number the gateway would contradict.
    for (const field of ["context", "price", "upstream", "baseUrl"]) {
      expect(NOTES, `${field} is editable here`).not.toMatch(new RegExp(`label.*${field}`, "i"));
    }
  });

  it("a cleared field becomes unset, not a stored blank", () => {
    expect(modelNotesPayload({ m1: { displayName: "  ", note: "", tags: [] } })).toEqual({
      modelNotes: {},
    });
  });

  it("a model with nothing on it is simply absent", () => {
    expect(Object.keys(modelNotesPayload({}))).toEqual(["modelNotes"]);
    expect(modelNotesPayload({})).toEqual({ modelNotes: {} });
  });
});
