/**
 * tests/unit/reasoning-levels-honest.test.ts
 *
 * A default list is a claim.
 *
 * The picker fell back to five common spellings when the deployment knew
 * nothing about the model, so every un-fetched model looked like a five-step
 * one. Somebody testing it saw "5 levels" on models that have no five levels,
 * and could not tell the difference between "the vendor published five" and
 * "we made five up".
 *
 * So: an empty list stays empty, the form says the vendor published none, and
 * the common spellings become hints to click rather than options to pick. The
 * deployment's own list, when it has one, is the only thing offered as the
 * model's levels.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
const credential = { created: true, enabled: true };
vi.mock("@/lib/assistant/credential-store", () => ({
  useCredentialStore: () => ({ data: credential, loaded: true }),
}));

const { AssistantSettingsPanel } = await import(
  "@/app/(user)/dashboard/assistant/AssistantSettingsPanel"
);
const { I18nProvider } = await import("@/components/i18n/I18nProvider");

function render(accountFacts: Record<string, unknown>): string {
  const panel = h(AssistantSettingsPanel, {
    initial: {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account" as const,
      hasApiKey: false,
    },
    accountModels: ["m"],
    accountFacts: accountFacts as never,
  });
  return renderToStaticMarkup(h(I18nProvider, { initialLocale: "zh-CN", children: panel }));
}

const accountPath = (facts: Record<string, unknown>) =>
  render({ m: { contextLength: 128000, maxOutputTokens: 8192, reasoningLevels: [], ...facts } });

describe("when the vendor published no levels", () => {
  it("the picker does not offer any", () => {
    // Not one of the five. A default list here reads as "this model has five
    // levels" to somebody who has no way to check, which is the whole problem.
    const html = accountPath({ reasoningLevels: [] });
    // As an <option>, which is the thing that says "this model takes it". The
    // same word as a button label says something weaker and is checked below.
    for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
      expect(html, `"${level}" is offered as an option the model published`).not.toContain(
        `<option value="${level}">`,
      );
    }
  });

  it("and it says so, rather than looking like a list that failed to load", () => {
    const html = accountPath({ reasoningLevels: [] });
    expect(html, "the form does not say the levels are unknown").toContain(
      "厂商的模型列表里没有公布",
    );
    // The custom field is the way through, and it is offered up front.
    expect(html, "there is no way to type a level").toContain("自定义");
  });

  it("the common spellings are hints to click, not options to choose", () => {
    const html = accountPath({ reasoningLevels: [] });
    // Present as buttons, so a click fills the field — a reader can see they
    // are somebody's guess rather than the model's own list. Checked as markup
    // because the handler itself does not survive server rendering.
    for (const level of ["minimal", "xhigh"]) {
      expect(html, `${level} is not offered as a hint`).toContain(`>${level}</button>`);
    }
  });
});

describe("when the vendor published levels", () => {
  it("only those are offered", () => {
    const html = accountPath({ reasoningLevels: ["think_low", "think_high"] });
    expect(html, "the vendor's own level is missing").toContain(">think_low<");
    expect(html, "the vendor's own level is missing").toContain(">think_high<");
    // …and none of the generic ones, because a model that publishes two does
    // not also publish four more.
    for (const level of ["minimal", "medium", "xhigh"]) {
      expect(html, `"${level}" is offered as an option on top of the vendor's list`).not.toContain(
        `<option value="${level}">`,
      );
    }
    expect(html, "the unknown notice shows even though levels are known").not.toContain(
      "厂商的模型列表里没有公布",
    );
  });
});
