/**
 * tests/unit/provider-routes-copy.test.ts
 *
 * The interface-routing section says one thing once.
 *
 * The section it replaced — the pair of protocol-face cards — said the same
 * thing four times: that the API key and the model mapping are shared between
 * the two sides was in the section hint, again in the Anthropic card's hint,
 * and a third time as a bullet in a warning box. The base-URL advice appeared
 * twice with different examples. A reader who hits four restatements of one
 * rule cannot tell which one is the rule, so they read all four and trust none.
 *
 * These tests pin the shape that fixes it: the section says what the three
 * answers mean, once; the base-URL advice is in one place; and nothing claims
 * the two configurations share a field.
 *
 * Source-level guards, as elsewhere in this suite — the strings are the defect,
 * and there is no test renderer in this project.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DICTS } from "@/lib/i18n/dict";

const SRC = join(process.cwd(), "src");
const ROUTES = readFileSync(
  join(SRC, "app/(admin)/admin/providers/ProviderSurfaceRoutes.tsx"),
  "utf-8",
);

const LOCALES = Object.keys(DICTS) as (keyof typeof DICTS)[];
const text = (locale: (typeof LOCALES)[number], key: string): string => DICTS[locale][key] ?? "";

/** Wording that says the configurations pool their fields. Wrong, on purpose. */
const SHARES = /共用|共享|shared/i;

describe("interface-routing section copy", () => {
  it("says what the three answers are, once", () => {
    // A picker whose options are not explained leaves the reader to work out
    // the difference between "not answered" and "answered in another shape" —
    // which is the difference between a provider that 404s and one that is
    // translated.
    for (const locale of LOCALES) {
      const hint = text(locale, "admin.providers.routes.hint");
      expect(hint, `${locale} hint says nothing about the three answers`).not.toBe("");
      for (const key of [
        "admin.providers.routes.unsupported",
        "admin.providers.routes.passthrough",
        "admin.providers.routes.route",
      ]) {
        expect(text(locale, key), `${locale} ${key}`).not.toBe("");
      }
    }
  });

  it("does not tell the reader the configurations share anything", () => {
    // The old hint said the key, model mapping and model configs were "shared
    // with advanced mode, not entered twice" — which describes two halves of
    // one job. They are two complete configurations: whichever you pick, you
    // fill that one in from top to bottom and never have to open the other.
    for (const locale of LOCALES) {
      const hint = text(locale, "admin.providers.routes.hint");
      expect(hint, `${locale} claims the configurations share fields`).not.toMatch(SHARES);
      expect(hint, `${locale} says the fields are only entered once`).not.toMatch(
        /不需要重复填写|not entered twice|only once/i,
      );
    }
  });

  it("keeps the base-URL advice in one place", () => {
    for (const locale of LOCALES) {
      const hint = text(locale, "admin.providers.routes.anthropicBaseUrlHint");
      expect(hint, `${locale} base URL hint`).toContain("minimax");
      // It used to appear here and again as a bullet in a tip below.
      expect(DICTS[locale], `${locale} dict`).not.toHaveProperty(
        "admin.providers.faces.anthropicTip.baseUrl",
      );
      expect(DICTS[locale], `${locale} dict`).not.toHaveProperty(
        "admin.providers.faces.anthropicTip.mapping",
      );
    }
    // And the field it describes is rendered once, in the one place that needs
    // it — the Anthropic surface, when it is answered natively.
    expect(ROUTES).toContain("admin.providers.routes.anthropicBaseUrl");
    expect(
      (ROUTES.match(/admin\.providers\.routes\.anthropicBaseUrl"/g) ?? []).length,
      "the base URL is asked for in more than one place",
    ).toBe(1);
  });

  it("and the old faces section is gone", () => {
    // The pair of face cards is not a second place to say the same thing, and
    // it is not the truth any more: the routes are.
    expect(() =>
      readFileSync(join(SRC, "app/(admin)/admin/providers/ProviderFacesField.tsx"), "utf-8"),
    ).toThrow();
    for (const locale of LOCALES) {
      expect(DICTS[locale], `${locale} dict`).not.toHaveProperty("admin.providers.faces.hint");
      expect(DICTS[locale], `${locale} dict`).not.toHaveProperty("admin.providers.faces.noneWarning");
    }
  });
});
