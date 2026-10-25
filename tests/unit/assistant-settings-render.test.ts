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
/**
 * Whether the credential state has arrived yet. Mutable for the same reason —
 * the two notices have to read the same way while it is still being read.
 */
const credentialStore = { loaded: true };
vi.mock("@/lib/assistant/credential-store", () => ({
  useCredentialStore: () => ({ data: credential, loaded: credentialStore.loaded }),
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

/**
 * The password fields on the page, counted by which field they are.
 *
 * The panel has **two** different keys now, and they are not the same
 * question: the assistant's **upstream** key (the chat model the user brings)
 * and the user's **own search service** key. Counting every `type="password"`
 * would make the second one look like the first, so each is counted by the
 * id its input carries.
 */
const inputTags = (html: string): string[] => html.match(/<input[^>]*>/g) ?? [];

/**
 * The amber notice boxes on the page.
 *
 * Counted by the class rather than by their words, because the words are prose
 * and prose is edited: a phrase that names the warning can also appear in the
 * description of a setting, and a test that looks for the phrase then fails
 * for a reason nobody would guess. The box is the thing being asserted.
 */
const noticeBoxes = (html: string): string[] =>
  html.match(/<p class="[^"]*border-amber-500\/40[^"]*">[\s\S]*?<\/p>/g) ?? [];

/** The class list of each amber notice box, in the order they appear. */
const noticeClasses = (html: string): string[] =>
  (html.match(/<p class="([^"]*border-amber-500\/40[^"]*)"/g) ?? []).map(
    (tag) => tag.slice(tag.indexOf('"') + 1, tag.lastIndexOf('"')),
  );

const countUpstreamKeyInputs = (html: string): number =>
  inputTags(html).filter(
    (tag) => tag.includes('id="assistant-api-key"') && tag.includes('type="password"'),
  ).length;

const countSearchKeyInputs = (html: string): number =>
  inputTags(html).filter(
    (tag) => tag.includes('id="assistant-search-api-key"') && tag.includes('type="password"'),
  ).length;

/**
 * The search-service picker: the select, and the services it offers.
 */
const servicePicker = (html: string): string | null =>
  html.match(/<select[^>]*id="assistant-search-service"[\s\S]*?<\/select>/)?.[0] ?? null;

const pickerOptions = (html: string): string[] => {
  const picker = servicePicker(html);
  if (!picker) return [];
  return (picker.match(/<option[^>]*>/g) ?? []).map((tag) => {
    const value = tag.match(/value="([^"]*)"/)?.[1] ?? "";
    return value;
  });
};

/** A webSearch block with the given services on offer. */
function webSearchWith(
  services: Array<{ id: string; name: string; kind: string }>,
  defaultServiceId: string | null = null,
) {
  return {
    available: true,
    defaultOn: true,
    limit: 6,
    maxResults: 8,
    backendName: null,
    backendSource: null,
    ownBaseUrl: null,
    ownHasKey: false,
    ownInUse: false,
    services,
    defaultServiceId,
  };
}

beforeEach(() => {
  credential.created = true;
  credential.enabled = true;
  credentialStore.loaded = true;
});

describe("the search service can be named, even when there is only one", () => {
  it("— one service is still a choice, and the choice is on the page", () => {
    // The picker used to appear only when the deployment had **several**
    // services, on the reasoning that a one-option picker is a question nobody
    // asked. That made the service unnameable on a deployment with one — which
    // is the deployment almost every reader is on, and the one this bug was
    // reported from. The name is what makes the choice informed: a person who
    // can see "自建 SearXNG" next to the switch knows whose bill is involved.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
      webSearch: webSearchWith([{ id: "searxng", name: "自建 SearXNG", kind: "searxng" }]),
    });

    expect(servicePicker(html), "the search service cannot be picked").toBeTruthy();
    expect(pickerOptions(html)).toContain("searxng");
    // And the name is on the page, not only the id.
    expect(html).toContain("自建 SearXNG");
  });

  it("— and with several, every one of them is on offer", () => {
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
      webSearch: webSearchWith([
        { id: "searxng", name: "自建 SearXNG", kind: "searxng" },
        { id: "tavily", name: "Tavily", kind: "tavily" },
      ]),
    });
    expect(pickerOptions(html)).toContain("searxng");
    expect(pickerOptions(html)).toContain("tavily");
  });

  it("— but not when the source is the user's own service", () => {
    // The own service is one address, not a list: there is nothing to pick.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "own",
        searchBaseUrl: "https://my-gateway.example.com/v1/search",
      },
      webSearch: webSearchWith([{ id: "searxng", name: "自建 SearXNG", kind: "searxng" }]),
    });
    expect(servicePicker(html), "the picker is offered for the user's own service").toBeNull();
  });
});

describe("the deployment's default service is the one the panel says is in effect", () => {
  it("— an account that chose nothing is told which one answers", () => {
    // The deployment marked one of its two services as the default. An account
    // that has not chosen gets that one — so the panel has to say which, not
    // ask the reader to pick, and not claim that nothing is in use.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
      webSearch: webSearchWith(
        [
          { id: "searxng", name: "自建 SearXNG", kind: "searxng" },
          { id: "tavily", name: "Tavily", kind: "tavily" },
        ],
        "tavily",
      ),
    });

    expect(html, "the default service is not named as the one in effect").toContain(
      "现在生效：站点的搜索服务（Tavily）",
    );
    // And "not picking one" says what it means now.
    expect(servicePicker(html)).toContain("不特别指定（就用站点的默认服务）");
    // And it does not ask them to choose, because there is nothing to choose.
    expect(html).not.toContain("选一个之后助手才会用站点的搜索");
  });

  it("— and with no default and several services, it says that instead", () => {
    // The old panel said "there is no default" here, and that stopped being
    // true when the operator could mark one. With no mark and several
    // services, the search is refused by name — and the panel says so.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
      webSearch: webSearchWith([
        { id: "searxng", name: "自建 SearXNG", kind: "searxng" },
        { id: "tavily", name: "Tavily", kind: "tavily" },
      ]),
    });

    expect(html).toContain("选一个之后助手才会用站点的搜索");
    expect(servicePicker(html)).toContain("还没选");
  });
});

describe("the account path shows no key field", () => {
  it("— one is not needed and one is not there", () => {
    // The whole point of the account path: it runs through this deployment with
    // a credential the system issues, so there is no secret to paste. A field
    // here reads as a requirement, and a requirement that does not exist is how
    // somebody ends up configuring a key they do not need.
    const html = render({ initial: { baseUrl: "", model: "", accountModel: "gpt-4o", credentialMode: "account", hasApiKey: false } });
    expect(countUpstreamKeyInputs(html), "a password field on the account path").toBe(0);
    expect(html, "the key field is present on the account path").not.toContain('name="apiKey"');
    expect(html, "the address field is present on the account path").not.toContain('name="baseUrl"');
    expect(html, "the account model picker is missing").toContain("用哪个模型");
    // The upstream form is genuinely absent, not merely hidden by a class, and
    // it is absent by its *label* — what a person would read.
    expect(html, "the key field is labelled on the account path").not.toContain("上游 API 密钥");
    expect(html, "the address field is labelled on the account path").not.toContain("API 地址");
  });

  it("— and the user's own search service is a separate key, behind its own choice", () => {
    // A **different** key, for a **different** thing: the user's own search
    // service is theirs on either path, and the account path has no reason to
    // hide it. Counting every password field would have mistaken this one for
    // the upstream key — which is why the two are counted by their own ids.
    //
    // The fields are behind the source choice, because a search service that
    // is not in use does not need its key on screen.
    for (const mode of ["account", "key"] as const) {
      const html = render({
        initial: {
          baseUrl: mode === "key" ? "https://api.example.com/v1" : "",
          model: mode === "key" ? "gpt-4o" : "",
          accountModel: "gpt-4o",
          credentialMode: mode,
          hasApiKey: false,
          searchSource: "own",
          searchBaseUrl: "https://my-gateway.example.com/v1/search",
        },
      });
      expect(countSearchKeyInputs(html), `no search-service key on the ${mode} path`).toBe(1);
      expect(html, `no search endpoint field on the ${mode} path`).toContain('name="searchBaseUrl"');
      // And the upstream key is still counted apart from it.
      expect(countUpstreamKeyInputs(html), `wrong upstream key count on the ${mode} path`).toBe(
        mode === "key" ? 1 : 0,
      );
    }
  });

  it("— and the source choice is shown, with the deployment's side as the default", () => {
    // "The address box is filled in" is not something a person can read on
    // the page, and a stored address with the deployment's provider in use
    // looks exactly like the opposite.
    const html = render({
      initial: { baseUrl: "", model: "", accountModel: "gpt-4o", credentialMode: "account", hasApiKey: false },
    });
    // The choice is there, by the words a person would read.
    expect(html, "no source choice on the page").toContain("站点的搜索");
    expect(html, "no source choice on the page").toContain("我自己的");
    // Nothing configured → the deployment's side, and no key field for a
    // service that is not in use.
    expect(html, "the search-service key is shown without a choice").not.toContain(
      'name="searchApiKey"',
    );
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
    expect(countUpstreamKeyInputs(html), "a password field on the account path").toBe(0);
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
    expect(countUpstreamKeyInputs(html), "the key path lost its key field").toBe(1);
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

describe("the account path takes a typed model, not only a listed one", () => {
  it("offers the same picker, custom option included, as the key path", () => {
    // A closed <select> here said this deployment can only serve what the
    // catalogue happens to list — a list of what is *configured*, not of what
    // the upstream serves. A model added upstream last week was not selectable,
    // and the field read as a statement about the deployment rather than about
    // the form.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        hasApiKey: false,
      },
    });
    expect(html, "no way to type a model on the account path").toContain("自定义");
    // …and the option to reach it is present, not just the label.
    expect(html, "the custom option is missing").toContain("__custom__");
  });

  it("and still lists what the deployment does have", () => {
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
      },
    });
    // The option's text rather than its attribute: which of the two React
    // emits is not what is being claimed here.
    expect(html).toContain(">gpt-4o</option>");
    expect(html).toContain(">deepseek-chat</option>");
  });

  it("and a stored value the deployment does not list opens in custom mode", () => {
    // The other half of the fix: a model that was configured before it was
    // listed, or added upstream afterwards, must be *kept* and editable — not
    // shown as nothing selected, which is what a closed list did with it.
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "some-new-upstream-model",
        credentialMode: "account",
        hasApiKey: false,
      },
    });
    expect(html, "an unlisted model is not kept").toContain("some-new-upstream-model");
    expect(html, "it is not editable either").toContain('id="assistant-account-model-text"');
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
    // The warning is a box, not a phrase. The phrase also appears in the
    // description of the deployment's search option, which is on the page
    // always and is not a warning — so a phrase-matching assertion here
    // failed for a reason nobody would guess.
    expect(noticeBoxes(html).length, "a warning on a working account credential").toBe(0);
  });
});

describe("the two credential notices are one notice", () => {
  /**
   * The same fact, in two costumes.
   *
   * The call mode at the top of the panel raised it as a bordered amber box
   * with a link to the place that fixes it. The deployment's search service,
   * further down, raised it as a line of amber text with no box, no link, and
   * a pointer to a block that does not exist — it said "below, in the assistant
   * credentials", but the credential is created on the *settings* page, under
   * "AI 助手权限", and the call-mode block is **above** the search block, not
   * below it.
   *
   * So the second one read as a different problem, and as a dead end: it named
   * a place to go and the place was wrong, and it gave the reader no way to get
   * there at all.
   */
  it("— one box in both places, not a box and a line", () => {
    credential.created = false;
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
    });

    // Two notices are on the page: the call mode's and the search service's.
    expect(noticeBoxes(html).length, "the two notices are not both boxes").toBe(2);
    // And they are the same box: the search one used to be a bare line of
    // amber text, which is why it did not match. The class list is compared
    // rather than the whole paragraph, because the two say different things.
    const classes = noticeClasses(html);
    expect(new Set(classes).size, `two different styles: ${classes.join(" | ")}`).toBe(1);

    // Both send the reader where it is fixed. The search one used to have no
    // link at all.
    const links = html.match(/href="\/dashboard\/settings"/g) ?? [];
    expect(links.length, "one of the notices has nowhere to send the reader").toBe(2);
  });

  it("— and they read the same way while the state is still being read", () => {
    credential.created = false;
    credentialStore.loaded = false;
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
    });

    // Two different sentences used to sit here ("checking your account
    // credential" and "reading the assistant credential's state"), for one
    // request. The reader sees one thing being read, so it says one thing.
    const loading = html.match(/正在[^<]*/g) ?? [];
    expect(new Set(loading).size, `two ways of saying the same wait: ${loading.join(" | ")}`).toBe(1);
  });

  it("— and the search notice points at the settings page, which is where it is", () => {
    credential.created = false;
    const html = render({
      initial: {
        baseUrl: "",
        model: "",
        accountModel: "gpt-4o",
        credentialMode: "account",
        hasApiKey: false,
        searchSource: "deployment",
      },
    });

    expect(html, "the search notice names a block that does not exist").not.toContain(
      "「助手凭据」",
    );
    expect(html, "the search notice says nothing about where to go").toContain(
      "站点的搜索服务也要「用我的账号身份」",
    );
  });
});
