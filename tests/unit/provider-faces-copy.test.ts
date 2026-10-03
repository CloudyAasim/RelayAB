/**
 * tests/unit/provider-faces-copy.test.ts
 *
 * The protocol-face section said the same thing four times.
 *
 * Reading the panel top to bottom, the fact that the API key and model mapping
 * are shared between the two sides was stated in the section hint, again in the
 * Anthropic card's hint, and a third time as a bullet in a warning box three
 * lines further down — three different sentences for one idea. The base-URL
 * advice appeared twice as well: once under the input, once as a bullet, with
 * different examples. And the section hint claimed each side "only needs a
 * toggle", which was not true of either one: the OpenAI side also carries a
 * format dropdown and the Anthropic side a URL field.
 *
 * The cost is not ugliness. A reader who hits four restatements of one rule has
 * no way to tell which one is the rule and which are emphasis, so they read all
 * four and trust none. These tests pin the shape that fixes it: the sharing
 * fact is stated once, each card hint says what its own toggle controls, and
 * the warning box holds the one fact a field's hint cannot state about itself.
 *
 * Source-level guards, as elsewhere in this suite — the strings are the defect,
 * and there is no test renderer in this project.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DICTS } from "@/lib/i18n/dict";

const SRC = join(process.cwd(), "src");
const FIELD = readFileSync(
  join(SRC, "app/(admin)/admin/providers/ProviderInterfacesField.tsx"),
  "utf-8",
);

const LOCALES = Object.keys(DICTS) as (keyof typeof DICTS)[];
const text = (locale: (typeof LOCALES)[number], key: string): string => DICTS[locale][key] ?? "";

/** The same idea in either language: "shared by both sides". */
const SHARES = /共用|共享|shared/i;

describe("protocol-face section copy", () => {
  it("states the sharing rule exactly once", () => {
    for (const locale of LOCALES) {
      // It lives in the block's own hint, which is now the single place the
      // interface switches and the per-interface rules are both described.
      expect(text(locale, "admin.interfaces.hint"), `${locale} block hint`).toMatch(SHARES);
      // The per-face hints say what each toggle controls. Restating the sharing
      // rule there is what produced three sentences for one idea.
      expect(text(locale, "admin.providers.faces.openai.hint"), `${locale} OpenAI hint`).not.toMatch(SHARES);
      expect(text(locale, "admin.providers.faces.anthropic.hint"), `${locale} Anthropic hint`).not.toMatch(SHARES);
    }
  });

  it("says the block covers both questions, not one of them", () => {
    // The block replaced two sections, so it has to say it holds both — or the
    // rules underneath read as a sub-setting of the toggles.
    const perLocale: Record<string, [RegExp, RegExp]> = {
      "zh-CN": [/接口/, /参数/],
      en: [/endpoint/i, /parameter/i],
    };
    for (const locale of LOCALES) {
      const [endpoints, parameters] = perLocale[locale] ?? [/$^/, /$^/];
      const hint = text(locale, "admin.interfaces.hint");
      expect(hint, `${locale} block hint names the endpoints`).toMatch(endpoints);
      expect(hint, `${locale} block hint names the parameters`).toMatch(parameters);
    }
  });

  it("names the endpoints each toggle controls", () => {
    // A toggle whose hint does not say what it turns off leaves the reader to
    // work out the blast radius from the label above it.
    for (const locale of LOCALES) {
      const openai = text(locale, "admin.providers.faces.openai.hint");
      expect(openai, `${locale} OpenAI hint`).toContain("/v1/chat/completions");
      expect(openai, `${locale} OpenAI hint`).toContain("/v1/responses");

      const anthropic = text(locale, "admin.providers.faces.anthropic.hint");
      expect(anthropic, `${locale} Anthropic hint`).toContain("/v1/messages");
      expect(anthropic, `${locale} Anthropic hint`).toContain("/anthropic/v1/messages");
    }
  });

  it("does not promise the sides are only toggles", () => {
    // The OpenAI side carries a format dropdown and the Anthropic side a URL
    // field, so "each side only needs a toggle" was false on screen.
    for (const locale of LOCALES) {
      expect(text(locale, "admin.providers.faces.hint")).not.toMatch(/只需要开关|only needs a toggle/i);
    }
  });

  it("keeps the base-URL advice in one place", () => {
    for (const locale of LOCALES) {
      const hint = text(locale, "admin.providers.faces.anthropic.baseUrlHint");
      expect(hint, `${locale} base URL hint`).toContain("minimax");
      // It used to appear here and again as a bullet in the tip below.
      expect(locale in DICTS ? DICTS[locale] : {}, `${locale} dict`).not.toHaveProperty(
        "admin.providers.faces.anthropicTip.baseUrl",
      );
      expect(DICTS[locale], `${locale} dict`).not.toHaveProperty(
        "admin.providers.faces.anthropicTip.mapping",
      );
    }
  });

  it("leaves the format dropdown labelled", () => {
    // "Responses（原生，直连不转换格式）" sat under the toggle with nothing
    // saying it was a setting — and not which side's protocol it described.
    expect(FIELD).toContain('t("admin.providers.format.label")');
  });
});
