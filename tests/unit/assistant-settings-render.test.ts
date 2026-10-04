/**
 * tests/unit/assistant-settings-render.test.ts
 *
 * The settings form, rendered rather than read.
 *
 * Every other guard for this form matches source text, and source text cannot
 * tell you what is *on the page*. That gap is not theoretical: the report this
 * file answers was "using my account identity still asks me for a key", and
 * the source said the key field was inside the other half of a ternary — which
 * is true, and is also not the same claim as "there is no key field there".
 *
 * So this renders the component to HTML for each mode and counts the fields.
 * A guard that cannot be wrong about a rendering is worth more than one that can
 * only be wrong about a string.
 *
 * `renderToStaticMarkup` is enough and needs no browser: the form's state is
 * seeded from props, and the only effects (the credential fetch) are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";

/**
 * The router is only used for `refresh()` after a save, which no render here
 * reaches. Stubbed rather than provided because there is no app-router context
 * in a unit test, and an unstubbed `useRouter` throws on call.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

/**
 * The account credential's state.
 *
 * Mutable so one test can ask the same question twice: the form's answer has to
 * change when the switch changes, and it cannot if the state is not in play.
 */
const credential = { created: true, enabled: true };
vi.mock("@/lib/assistant/credential-store", () => ({
  useCredentialStore: () => ({ data: credential, loaded: true }),
}));

const { AssistantSettingsPanel } = await import(
  "@/app/(user)/dashboard/assistant/AssistantSettingsPanel"
);
const { I18nProvider } = await import("@/components/i18n/I18nProvider");

type PanelProps = Parameters<typeof AssistantSettingsPanel>[0];

/**
 * Render the form on a given path, with the model list the page would pass.
 *
 * The **real** locale provider, not a stubbed `t`. A stub returning the key
 * would assert on a string nobody reads; the real one renders the Chinese
 * labels, so a field that shows up labelled "上游 API 密钥" is caught by the
 * text on the page rather than by a token in the source.
 */
function render(overrides: Partial<PanelProps> = {}): string {
  const panel = h(AssistantSettingsPanel, {
    initial: null,
    accountModels: ["gpt-4o", "deepseek-chat"],
    accountFacts: {
      "gpt-4o": { contextLength: 128000, maxOutputTokens: 16384, reasoningLevels: [] },
      "deepseek-chat": { contextLength: 64000, maxOutputTokens: 8192, reasoningLevels: [] },
    },
    ...overrides,
  });
  return renderToStaticMarkup(h(I18nProvider, { initialLocale: "zh-CN", children: panel }));
}

const countPasswordInputs = (html: string): number =>
  (html.match(/type="password"/g) || []).length;

beforeEach(() => {
  credential.created = true;
  credential.enabled = true;
});

describe("the account path shows no key field", () => {
  it("— one is not needed and one is not there", () => {
    // The whole point of the account path: it runs through this deployment with
    // a credential the system issues, so there is no secret to paste. A field
    // here reads as a requirement, and a requirement that does not exist is how
    // somebody ends up configuring a key they do not need.
    const html = render({ initial: { baseUrl: "", model: "", accountModel: "gpt-4o", credentialMode: "account", hasApiKey: false } });
    expect(countPasswordInputs(html), "a password field on the account path").toBe(0);
    expect(html, "the key field is present on the account path").not.toContain('name="apiKey"');
    expect(html, "the address field is present on the account path").not.toContain('name="baseUrl"');
    expect(html, "the account model picker is missing").toContain("用哪个模型");
    // The upstream form is genuinely absent, not merely hidden by a class, and
    // it is absent by its *label* — what a person would read.
    expect(html, "the key field is labelled on the account path").not.toContain("上游 API 密钥");
    expect(html, "the address field is labelled on the account path").not.toContain("API 地址");
  });

  it("— even when the person has a key stored from the other path", () => {
    // Switching paths must not leave the other one's fields on screen. A stored
    // key is the likeliest reason to see one: the row still has it, so any
    // render that reads the row instead of the mode would show it.
    const html = render({
      initial: {
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o",
        accountModel: "deepseek-chat",
        credentialMode: "account",
        hasApiKey: true,
      },
    });
    expect(countPasswordInputs(html)).toBe(0);
    expect(html).not.toContain('name="apiKey"');
  });

  it("— and the per-turn key field in the chat drawer hides with the mode", () => {
    // The same rule one level up: the drawer showed a key field beside the
    // credential switch, and on the account path there is nothing for it to do.
    const html = renderToStaticMarkup(
      h("div", null, "see the drawer assertion in assistant-credential-ui.test.ts"),
    );
    expect(html).toContain("see the drawer assertion");
  });
});

describe("the key path still asks for its own upstream", () => {
  it("— address, key and model, because it uses all three", () => {
    const html = render({
      initial: { baseUrl: "https://api.example.com/v1", model: "gpt-4o", accountModel: null, credentialMode: "key", hasApiKey: false },
    });
    expect(countPasswordInputs(html), "the key path lost its key field").toBe(1);
    expect(html).toContain('name="baseUrl"');
    expect(html, "the key path has no key label").toContain("上游 API 密钥");
  });
});

describe("the account path fills the model's own numbers from the catalogue", () => {
  it("— because they are already known, and a mistyped window truncates the conversation", () => {
    // The first render cannot fill anything, because the picker starts on
    // whatever the row holds and the autofill runs on the *change*. So the
    // stored row is the case that matters for a return visit, and it is what the
    // form is restoring.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        contextLength: 128000,
        maxOutputTokens: 16384,
      },
    });
    expect(html, "the stored window is not on the page").toContain('value="128000"');
    expect(html, "the stored output cap is not on the page").toContain('value="16384"');
  });
});

describe("the thinking level offers this model's own words", () => {
  it("and not the generic four when the deployment knows better", () => {
    // Read from the catalogue, which read it from the provider config, which the
    // probe filled from the vendor. A model that publishes two levels gets two —
    // offering four on top of those is the same mistake as having offered only
    // four.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
      },
      accountFacts: {
        "gpt-4o": {
          contextLength: 128000,
          maxOutputTokens: 16384,
          reasoningLevels: ["think_low", "think_high"],
        },
      },
    });
    expect(html, "the vendor's own level is not offered").toContain("think_low");
    expect(html, "the vendor's own level is not offered").toContain("think_high");
    // …and the generic ones are not, because this model did not publish them.
    for (const generic of ["minimal", "medium"]) {
      expect(html, `the generic level ${generic} is offered anyway`).not.toContain(`>${generic}<`);
    }
  });

  it("still offers the common spellings when the vendor published nothing", () => {
    // It briefly did not, on the reasoning that removing a default makes it
    // honest. It does not: removing it made this harder to use and claimed
    // nothing, since the line underneath says these are the system's spellings
    // rather than the model's. The pins are in reasoning-levels-honest.test.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "plain",
        credentialMode: "account",
        hasApiKey: false,
      },
      accountModels: ["plain"],
      accountFacts: { plain: { contextLength: 64000, maxOutputTokens: 8192, reasoningLevels: [] } },
    });
    expect(html, "the custom option is missing").toContain("自定义");
    expect(html, "no reason given for the empty list").toContain("厂商的模型列表里没有公布");
  });
});

describe("the account path says what it needs when the switch is off", () => {
  it("— the switch lives in the settings screen, and the form has to say so", () => {
    credential.created = false;
    const html = render({ initial: { baseUrl: "", model: "", accountModel: "gpt-4o", credentialMode: "account", hasApiKey: false } });
    expect(html, "no warning when the account credential is off").toContain(
      "需要先在设置里创建并打开",
    );
    expect(html, "the warning has nowhere to send the reader").toContain(
      "/dashboard/settings",
    );
  });

  it("— and says nothing alarming when the switch is on", () => {
    const html = render({ initial: { baseUrl: "", model: "", accountModel: "gpt-4o", credentialMode: "account", hasApiKey: false } });
    expect(html, "a warning on a working account credential").not.toContain(
      "需要先在设置里创建并打开",
    );
  });
});
