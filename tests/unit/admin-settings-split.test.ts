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
import {
  modelConfigPayload,
  rowProblem,
  rowSummary,
  type ModelConfigRow,
} from "@/lib/admin/model-config";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PAGES = read("src", "app", "(admin)", "admin", "settings", "DocsPagesForm.tsx");
const SITE = read("src", "app", "(admin)", "admin", "settings", "DocsSiteForm.tsx");
const CONFIG = read("src", "app", "(admin)", "admin", "model-notes", "ModelConfigForm.tsx");
const SETTINGS_PAGE = read("src", "app", "(admin)", "admin", "settings", "page.tsx");
const NOTES_PAGE = read("src", "app", "(admin)", "admin", "model-notes", "page.tsx");
const NAV = read("src", "components", "layouts", "AuthenticatedLayout.tsx");

/** One gateway-editable row, as the editor would hold it. */
const row = (over: Partial<ModelConfigRow> = {}): ModelConfigRow => ({
  store: "provider",
  providerId: "p1",
  providerName: "MiniMax",
  clientId: "M3",
  kind: "chat",
  capability: null,
  endpoint: null,
  gatewayEditable: true,
  upstreamId: "M3",
  displayName: "M3",
  contextLength: 200000,
  maxOutputTokens: 8192,
  inputCost: 1,
  outputCost: 2,
  enabled: true,
  pricePerItem: null,
  note: "",
  tags: "",
  hidden: false,
  ...over,
});

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

  it("the model form sends its own two, and no settings keys at all", () => {
    // It writes to a different resource — the provider record — so it must not
    // travel through the settings endpoint with the other two.
    expect(Object.keys(modelConfigPayload([row()])).sort()).toEqual(["models", "notes"]);
  });

  it("so saving one cannot rewrite the other two", () => {
    // The behaviour under test, stated directly: each payload must not mention
    // the other forms' keys. The endpoint writes only what it is given, so a
    // form that sends `modelNotes` while saving the site name is the bug.
    const pages = JSON.stringify(docsPagesPayload([{ id: "a", title: "A", body: "x" }]));
    const site = JSON.stringify(docsSitePayload({ siteName: "n" }));
    const model = JSON.stringify(modelConfigPayload([row()]));

    expect(pages).not.toMatch(/modelNotes|siteName|publicCatalog|announcement|supportContact/);
    expect(site).not.toMatch(/modelNotes|docPages/);
    expect(model).not.toMatch(/docPages|siteName|publicCatalog|announcement|supportContact/);
  });

  it("the model form has its own endpoint, because its data lives elsewhere", () => {
    // A context window is a provider field. Sending it to /api/admin/settings
    // would be a lie about where it lands, and it would land nowhere.
    expect(CONFIG).toMatch(/"\/api\/admin\/model-config"/);
    expect(CONFIG).not.toMatch(/"\/api\/admin\/settings"/);
  });
});

describe("each section has its own save", () => {
  it("two buttons on this page, not one", () => {
    const buttons = [CONFIG, PAGES].filter((f) => f.includes("admin.docsSettings.save"));
    expect(buttons).toHaveLength(2);
  });

  it("and the combined form is gone", () => {
    // It cannot merely be unused: a component that still writes all three keys
    // from one form is the defect, whatever imports it.
    expect(() => read("src", "app", "(admin)", "admin", "settings", "DocsSettingsForm.tsx")).toThrow();
  });

  it("the site form has its own, over on the settings page", () => {
    expect(SITE).toMatch(/useSettingsSave/);
    const helper = read("src", "components", "admin", "useSettingsSave.ts");
    expect(helper).toMatch(/router\.refresh\(\)/);
    expect(helper).toMatch(/setMessage/);
  });
});

describe("the model notes are their own page, and carry the configuration too", () => {
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

  it("and the model list is gone from the system settings", () => {
    expect(SETTINGS_PAGE).not.toMatch(/ModelConfigForm/);
    expect(SETTINGS_PAGE).not.toMatch(/modelNotes/);
  });

  it("it still gets its rows from the live providers, not from a copy", () => {
    expect(NOTES_PAGE).toMatch(/listProviders/);
    expect(NOTES_PAGE).toMatch(/listMediaProviders/);
  });

  it("and it holds the custom documentation too", () => {
    expect(NOTES_PAGE).toMatch(/<DocsPagesForm/);
  });
});

describe("the rows are collapsed until asked for", () => {
  /**
   * Fifteen models of eleven fields is two hundred controls on one screen, and
   * the question an operator usually has is "what does this one model do". A
   * row that opens by default answers neither.
   */
  it("no row starts expanded", () => {
    expect(CONFIG).toMatch(/useState<Set<string>>\(new Set\(\)\)/);
    expect(CONFIG).not.toMatch(/new Set\(list\.map/);
  });

  it("and the whole section can be folded away too", () => {
    expect(CONFIG).toMatch(/const \[sectionOpen, setSectionOpen\] = useState\(true\)/);
    expect(CONFIG).toMatch(/aria-expanded=\{sectionOpen\}/);
  });

  it("a collapsed row still says enough to recognise it", () => {
    // The provider, the window, whether it is off — otherwise finding the right
    // row means expanding all of them.
    expect(CONFIG).toMatch(/rowSummary\(row\)/);
  });

  it("and the summary is built from the row's real state", () => {
    const off = rowSummary({ ...row(), enabled: false });
    expect(off).toMatch(/停用/);
    const hidden = rowSummary({ ...row(), hidden: true });
    expect(hidden).toMatch(/文档已隐藏/);
    const noted = rowSummary({ ...row(), note: "一句话" });
    expect(noted).toMatch(/已写说明/);
    // A media model has no token window, so the summary must not claim one.
    const media = rowSummary({ ...row({ store: "media", kind: "media", gatewayEditable: false }), capability: "image.generate" });
    expect(media).toContain("image.generate");
    expect(media).not.toMatch(/200k/);
  });
});

describe("what a row is allowed to offer", () => {
  it("a chat model carries the whole OpenAI-compatible configuration", () => {
    const out = modelConfigPayload([row()]);
    expect(out.models).toHaveLength(1);
    // The two cache prices are in the list, and they are *always* present: this
    // route merges, so an absent field reads as "keep the stored price" and a
    // cleared box would be unable to clear anything. Blank travels as `null`.
    expect(Object.keys(out.models[0]).sort()).toEqual(
      [
        "cachedInputCost",
        "cacheWriteCost",
        "clientId",
        "contextLength",
        "displayName",
        "enabled",
        "inputCost",
        "maxOutputTokens",
        "outputCost",
        "providerId",
        "upstreamId",
      ].sort(),
    );
    expect(out.models[0].cachedInputCost).toBeNull();
    expect(out.models[0].cacheWriteCost).toBeNull();
  });

  it("a zero cache price is a price, not an absence", () => {
    // "This cache is free" and "this cache was never priced" are different
    // answers, and only the first is a decision. Collapsing them would make a
    // free cache unpriceable.
    const out = modelConfigPayload([row({ cachedInputCost: 0, cacheWriteCost: 12 })]);
    expect(out.models[0].cachedInputCost).toBe(0);
    expect(out.models[0].cacheWriteCost).toBe(12);
  });

  it("a media model does not, because a spec drives it", () => {
    // A context window and a token price on a media model would be fields that
    // save and do nothing.
    const out = modelConfigPayload([
      row({ store: "media", kind: "media", gatewayEditable: false, capability: "image.generate" }),
    ]);
    expect(out.models).toHaveLength(0);
    // Its documentation note still saves.
    expect(out.notes).toBeTypeOf("object");
  });

  it("a cleared field becomes unset, not a stored blank", () => {
    expect(modelConfigPayload([row({ note: "  ", tags: " , " })]).notes).toEqual({});
  });

  it("a model with nothing on it is simply absent from the notes", () => {
    expect(modelConfigPayload([row()]).notes).toEqual({});
  });

  it("the note keeps its tags as a list, not a string", () => {
    const out = modelConfigPayload([row({ tags: "chat, vision , fast" })]);
    expect(out.notes.M3?.tags).toEqual(["chat", "vision", "fast"]);
  });
});
