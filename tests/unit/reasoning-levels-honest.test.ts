/**
 * tests/unit/reasoning-levels-honest.test.ts
 *
 * The presets stayed; the lie went.
 *
 * Two errors in a row, both mine. First the picker fell back to the five common
 * spellings whenever the deployment knew nothing, so every un-fetched model
 * looked like a five-step one. Then, correcting that, I removed the presets
 * entirely — which made it *harder* to use for no gain, since most
 * OpenAI-compatible models do take these four and anybody who knows a model's
 * window knows its levels.
 *
 * So the presets are offered, and the line underneath says which of the two
 * situations this is: the vendor's own list, or the common spellings that this
 * system knows about. A default list is fine as long as it is labelled as one.
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

function render(levels: string[]): string {
  const panel = h(AssistantSettingsPanel, {
    initial: {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account" as const,
      hasApiKey: false,
    },
    accountModels: ["m"],
    accountFacts: {
      m: { contextLength: 128000, maxOutputTokens: 8192, reasoningLevels: levels },
    } as never,
  });
  return renderToStaticMarkup(h(I18nProvider, { initialLocale: "zh-CN", children: panel }));
}

const COMMON = ["minimal", "low", "medium", "high"];

describe("when the vendor published no levels", () => {
  it("the common spellings are still offered — removing them helped nobody", () => {
    const html = render([]);
    for (const level of COMMON) {
      expect(html, `${level} is not offered`).toContain(`<option value="${level}">`);
    }
  });

  it("and it says they are this system's, not this model's", () => {
    // The whole point of offering them. Without this line the list is a claim
    // about the model; with it, it is a starting point the reader can check.
    const html = render([]);
    expect(html, "the presets are not labelled as presets").toContain(
      "厂商的模型列表里没有公布",
    );
    expect(html, "the presets are not labelled as presets").toContain("常见写法");
  });

  it("and the custom field is there for anything else", () => {
    expect(render([])).toContain("自定义");
  });
});

describe("when the vendor published levels", () => {
  it("only those are offered, and nothing is labelled a preset", () => {
    const html = render(["think_low", "think_high"]);
    expect(html, "the vendor's own level is missing").toContain('<option value="think_low">');
    expect(html, "the vendor's own level is missing").toContain('<option value="think_high">');
    // …and the generic ones are not on top of them.
    for (const level of COMMON) {
      expect(html, `"${level}" is offered on top of the vendor's list`).not.toContain(
        `<option value="${level}">`,
      );
    }
    // The note is the tell: with the vendor's list in place, there is nothing
    // to warn about.
    expect(html, "the preset warning shows even though levels are known").not.toContain(
      "厂商的模型列表里没有公布",
    );
  });
});
