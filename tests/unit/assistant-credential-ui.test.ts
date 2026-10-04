/**
 * tests/unit/assistant-credential-ui.test.ts
 *
 * The credential panel replaced a key field that used to sit at the top of both
 * testers, and two things went wrong that only a person looking at the screen
 * would have caught:
 *
 *   1. the old key fields stayed, so each card showed two of them and the
 *      account path silently ignored the top one;
 *   2. the page opened on "use my account" while that option was disabled -
 *      for anyone who had not created a credential - and because the key field
 *      is hidden while it is selected, the page looked like it had no way to
 *      run a test at all.
 *
 * These are source-level guards on purpose. The behaviour lives in a client
 * component whose state machine is only exercised by a real click, and the
 * defect was "a field that should not be there", which is exactly the kind of
 * thing a test has to name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconcileMode, optionAppearance } from "@/lib/assistant/CredentialPanel";

const SRC = join(process.cwd(), "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf-8");

const CHAT_TESTER = read("app/(user)/dashboard/models/ModelTester.tsx");
const MEDIA_TESTER = read("app/(user)/dashboard/models/MediaTester.tsx");
const PANEL = read("lib/assistant/CredentialPanel.tsx");
/** The assistant chat screen itself, as opposed to the two testers. */
const CHAT = read("app/(user)/dashboard/assistant/AssistantChat.tsx");
const STORE = read("lib/assistant/credential-store.ts");

describe("credential UI: one key field, owned by the panel", () => {
  it("neither tester keeps its own key input", () => {
    for (const [name, source] of [
      ["ModelTester", CHAT_TESTER],
      ["MediaTester", MEDIA_TESTER],
    ] as const) {
      // A password input bound to relayKey is the old duplicate. The panel's
      // own field lives in CredentialPanel.tsx and is not in this list.
      expect(source, `${name} still renders its own key field`).not.toMatch(
        /type="password"[\s\S]{0,400}value=\{relayKey\}/,
      );
    }
  });

  it("both testers route the key through the panel", () => {
    for (const [name, source] of [
      ["ModelTester", CHAT_TESTER],
      ["MediaTester", MEDIA_TESTER],
    ] as const) {
      expect(source, `${name} does not mount CredentialChoice`).toContain("<CredentialChoice");
    }
  });

  it("the media tester can actually spend the account credential", () => {
    // Mounting the choice is not enough: without the account branch a user who
    // switched it on would still be told to paste a key.
    expect(MEDIA_TESTER).toContain("/api/assistant/test-media");
    expect(MEDIA_TESTER).toMatch(/credentialMode === "account"/);
  });

  it("keeps the account switch on the settings screen, not in a drawer", () => {
    // It is an account-level decision - may the assistant spend my quota on my
    // behalf - so it belongs with the other account settings, where it was
    // previously buried under a model configuration and read as a per-screen
    // option.
    const settings = readFileSync(join(process.cwd(), "src", "app", "(user)", "dashboard", "settings", "page.tsx"), "utf-8");
    expect(settings).toContain("<AccountCredentialPanel");
    expect(CHAT, "the assistant drawer still mounts the account switch").not.toContain("<AccountCredentialPanel");
  });

  it("puts the credential card first, where the eye lands", () => {
    // Asked for directly: it is the setting that is easy to miss everywhere
    // else, and a fourth card below three of the usual ones is the fourth card.
    const settings = readFileSync(join(process.cwd(), "src", "app", "(user)", "dashboard", "settings", "page.tsx"), "utf-8");
    const first = settings.indexOf("<Card>");
    expect(first, "the credential card is not the first one on the page").toBeGreaterThan(-1);
    const panel = settings.indexOf("<AccountCredentialPanel");
    const profile = settings.indexOf("settings.profile.title");
    const timezone = settings.indexOf("settings.timezone.title");
    const password = settings.indexOf("settings.password.title");
    expect(panel).toBeGreaterThan(-1);
    // Ahead of every other card, not merely somewhere on the page.
    expect(panel).toBeLessThan(profile);
    expect(panel).toBeLessThan(timezone);
    expect(panel).toBeLessThan(password);
    expect(settings.slice(first, panel)).toContain("settings.assistantCredential.title");
  });

  it("sets the state apart from the label it belongs to", () => {
    // "允许助手用我的账号调用 已开启" ran together as one phrase, so the state -
    // the part worth noticing - read as part of the title. A gap on the row and
    // a pill on the state, rather than a recoloured word.
    const header = PANEL.slice(
      PANEL.indexOf("export function AccountCredentialPanel"),
      PANEL.indexOf("export function CredentialChoice"),
    );
    expect(header).toMatch(/flex flex-wrap items-center gap-x-3 gap-y-1/);
    const label = header.indexOf("assistant.credential.switch\"");
    const pill = header.indexOf("rounded-full px-2 py-0.5");
    expect(pill).toBeGreaterThan(label);
    expect(header).toContain("bg-primary/10 text-primary");
    expect(header).toContain("bg-muted text-muted-foreground");
  });

  it("leaves the per-screen choice where the call is made", () => {
    // The switch decides whether account calls are allowed; the choice decides
    // which credential this screen spends. Collapsing the two is what put an
    // account setting inside a conversation drawer.
    expect(PANEL).toContain("export function AccountCredentialPanel");
    expect(PANEL).toContain("export function CredentialChoice");
    const accountSwitch = PANEL.slice(PANEL.indexOf("export function AccountCredentialPanel"));
    const choice = PANEL.slice(PANEL.indexOf("export function CredentialChoice"));
    expect(accountSwitch).toContain("assistant.credential.switch");
    expect(choice).toContain("assistant.credential.which");
    // And the choice does not carry the create/remove lifecycle.
    expect(choice).not.toContain("assistant.credential.remove");
  });

  it("points at the settings screen from the option the reader is looking at", () => {
    // The hint belongs inside the disabled account option itself. A link parked
    // in a paragraph elsewhere left the radio looking broken rather than
    // unavailable, which is the same misread the setting move was fixing.
    const choice = PANEL.slice(PANEL.indexOf("export function CredentialChoice"));
    expect(choice).toContain("assistant.credential.modeAccountLocked");
    expect(choice).toContain('href="/dashboard/settings"');
  });

  it("lets every capability spend the account, transcription included", () => {
    // Transcription was the one capability the panel refused to run on the
    // account path, because it carries a file and the route spoke JSON. The
    // route now takes multipart for exactly that case, so the exclusion is
    // gone — and it has to be gone, or the capability that most needs testing
    // is the one the user cannot test without pasting a key.
    expect(MEDIA_TESTER, "the account path is still blocked for stt").not.toContain("accountBlockedReason");
    expect(MEDIA_TESTER).toMatch(/credentialMode === "account"[\s\S]{0,400}isStt && file/);
    expect(MEDIA_TESTER).toMatch(/form\.append\("file", file\)/);
    // …and the key path still works, because that is the other half of the page.
    expect(MEDIA_TESTER).toMatch(/v1\/audio\/transcriptions/);
  });
});

describe("credential UI: the page never rests on an unusable option", () => {
  /**
   * Tested as a decision rather than through a click. The rule is pure, and
   * the built-in browser here does not hydrate React at all, so a UI test
   * would have been asserting nothing.
   */
  const decide = (o: {
    loaded?: boolean;
    canUseAccount?: boolean;
    mode?: "account" | "key";
    userPicked?: boolean;
    hasKey?: boolean;
  }) =>
    reconcileMode({
      loaded: o.loaded ?? true,
      canUseAccount: o.canUseAccount ?? false,
      mode: o.mode ?? "account",
      userPicked: o.userPicked ?? false,
      hasKey: o.hasKey ?? false,
    });

  it("leaves the initial choice alone until the state is known", () => {
    // Guessing before the fetch lands would flash the wrong thing at someone
    // whose credential is perfectly fine.
    expect(decide({ loaded: false, canUseAccount: true })).toBe("account");
    expect(decide({ loaded: false, canUseAccount: false })).toBe("account");
  });

  it("falls back to the key path when the account path cannot be used", () => {
    expect(decide({ canUseAccount: false, mode: "account" })).toBe("key");
  });

  it("follows the account path once a credential is switched on", () => {
    expect(decide({ canUseAccount: true, mode: "key" })).toBe("account");
  });

  it("does not discard a key someone has already typed", () => {
    expect(decide({ canUseAccount: true, mode: "key", hasKey: true })).toBe("key");
  });

  it("never second-guesses a choice the user made", () => {
    expect(decide({ canUseAccount: false, mode: "account", userPicked: true })).toBe("account");
    expect(decide({ canUseAccount: true, mode: "key", userPicked: true })).toBe("key");
  });

  it("leaves a settled choice alone", () => {
    expect(decide({ canUseAccount: true, mode: "account" })).toBe("account");
    expect(decide({ canUseAccount: false, mode: "key" })).toBe("key");
  });

  it("is driven by the component rather than duplicated beside it", () => {
    expect(PANEL).toContain("reconcileMode(");
    expect(PANEL).toMatch(/const next = reconcileMode\(/);
  });

  it("shows the key field only while the key path is selected", () => {
    expect(PANEL).toMatch(/\{mode === "key" && \(/);
  });

  it("gives each instance its own radio group", () => {
    // The model test page mounts two of these and the assistant drawer a third.
    // A constant `name` makes them one group to the browser, so choosing an
    // option in one panel unchecks the others' radios — while each panel's
    // `checked` is controlled by its own state and does not hear about it. What
    // is left on screen is not what the next call is made with, which is the
    // part that makes this a bug rather than a cosmetic one.
    expect(PANEL, "the radio group name is shared by every instance").not.toMatch(
      /const modeGroup = "/,
    );
    expect(PANEL).toMatch(/const modeGroup = `\$\{instanceId\}-mode`;/);
    // …and the id it is built from is per instance, like the key field beside it.
    expect(PANEL).toMatch(/const instanceId = useId\(\);/);
    // Both radios in one group, so they are still exclusive within a panel.
    expect((PANEL.match(/name=\{modeGroup\}/g) ?? []).length).toBe(2);
  });
});

/**
 * An option that is both "chosen" and "cannot be picked" is the bug that started
 * all of this. The two states are now separate, and the appearance is a pure
 * function precisely so that "the selected colours never appear on an
 * unavailable option" is a tested claim.
 */
describe("credential UI: option appearance", () => {
  it("marks a chosen, available option with the selected treatment", () => {
    const look = optionAppearance({ selected: true, available: true });
    expect(look.selected).toBe(true);
    expect(look.unavailable).toBe(false);
    expect(look.className).toContain("border-primary");
    expect(look.className).toContain("ring-primary");
  });

  it("never puts the selected treatment on an option that cannot be picked", () => {
    const look = optionAppearance({ selected: true, available: false });
    expect(look.unavailable).toBe(true);
    expect(look.className).not.toContain("primary");
    // And it is not merely dimmed: opacity was what made it read as "on and
    // broken" rather than "unavailable".
    expect(look.className).not.toContain("opacity-50");
  });

  it("dims an option that is neither selected nor available", () => {
    const look = optionAppearance({ selected: false, available: false });
    expect(look.className).toContain("opacity-60");
    expect(look.className).not.toContain("primary");
  });

  it("leaves an available, unselected option plain", () => {
    const look = optionAppearance({ selected: false, available: true });
    expect(look.className).toBe("border-border");
  });
});

describe("credential UI: one state for every panel", () => {
  it("the panel reads the shared store instead of fetching its own copy", () => {
    // Two panels on the tester page, each with its own copy of the state, is
    // how creating a credential in one left the other claiming none existed.
    // Match the call, not the import: an unused import still contains the name.
    expect(PANEL).toMatch(/=\s*useCredentialStore\(\)/);
    expect(PANEL).not.toMatch(/fetch\("\/api\/assistant\/credentials"/);
  });

  it("a change also re-renders the server components around it", () => {
    // The admin's key list is a server component; nothing it renders moves
    // until the page is re-fetched.
    expect(PANEL).toContain("refreshServer()");
  });

  it("the store deduplicates the first load", () => {
    expect(STORE).toContain("inFlight");
    expect(STORE).toContain("useSyncExternalStore");
  });

  it("busy state is shared, so two panels cannot both be mid-request", () => {
    expect(STORE).toMatch(/publish\(\{ busy: action, error: null \}\)/);
    expect(STORE).toMatch(/publish\(\{ busy: null \}\)/);
  });
});

describe("credential UI: the testers' spacing", () => {
  it("the media run button and its reasons are not on one line", () => {
    // Two hints and a button used to sit shoulder to shoulder in a flex row,
    // reading as a single run-on line.
    expect(MEDIA_TESTER).not.toMatch(
      /<div className="flex items-center gap-2">\s*<Button onClick=\{run\}/,
    );
  });

  it("the file picker is boxed like every other field", () => {
    expect(MEDIA_TESTER).toMatch(/type="file"[\s\S]{0,400}border border-input/);
  });

  it("a lone field in a two-column grid spans the row", () => {
    expect(MEDIA_TESTER).toContain("sm:col-span-2");
  });
});

/**
 * One configuration, one form, one source of truth — and a model on both paths.
 *
 * The drawer used to hold three controls for two settings: a mode switch, an
 * account-path model dropdown, and a settings form that was only rendered on
 * the key path. The mode and the account model were component state, so a chosen
 * model was gone on the next refresh; and the account path had no form at all,
 * which is why it looked unconfigurable. Meanwhile the chat route answered an
 * empty model with `allowed[0]` — a model nobody picked — so an unconfigured
 * assistant still worked and looked fine doing it.
 *
 * The guards below pin the replacement. The account path still runs through the
 * proxy rather than over HTTP, because that has not changed and is why the
 * upstream fields can be hidden on it: the credential keeps only a sha256 of a
 * secret that was discarded at creation (`db/assistant-keys.ts`), so it provably
 * cannot be sent as a bearer token.
 */
describe("credential UI: one form, and a model on both paths", () => {
  const CHAT = read("app/(user)/dashboard/assistant/AssistantChat.tsx");
  const CHAT_ROUTE = read("app/api/assistant/chat/route.ts");
  const CLIENT = read("lib/assistant/client.ts");
  const SETTINGS_PANEL_SRC = read("app/(user)/dashboard/assistant/AssistantSettingsPanel.tsx");
  const CONFIG = read("lib/assistant/config.ts");

  it("the settings form is rendered unconditionally, and it owns the mode", () => {
    // Not `credentialMode === "key" && ...`. That conditional is what left the
    // account path with nothing to configure, and what made the same setting
    // have two homes.
    expect(SETTINGS_PANEL_SRC).not.toMatch(/credentialMode === "key"/);
    expect(CHAT).toContain("{settingsPanel}");
    // And the mode switch lives in the form, not beside it.
    expect(SETTINGS_PANEL_SRC).toMatch(/const \[mode, setMode\] = useState<AssistantCredentialMode>/);
    expect(SETTINGS_PANEL_SRC, "the chat still keeps a mode of its own").not.toContain(
      "setCredentialMode",
    );
  });

  it("the account path asks for a model, from this deployment's own list", () => {
    // A closed select, because the list is the deployment's rather than the
    // user's — and a real one, with no "pick one for me" entry.
    expect(SETTINGS_PANEL_SRC).toContain("accountModels");
    expect(SETTINGS_PANEL_SRC).toMatch(/\{accountModels\.map\(\(m\) => \(/);
    expect(SETTINGS_PANEL_SRC).toMatch(/value=\{accountModel\}/);
    expect(SETTINGS_PANEL_SRC).not.toContain("assistant.accountModelAuto");
  });

  it("the model is stored, not carried by the request", () => {
    // This is the persistence bug. The request used to name the mode and the
    // model, which is how a choice could apply to one turn and be forgotten by
    // the next; the only thing a turn may still carry is the secret.
    expect(CHAT, "the request still names the mode").not.toMatch(/credentialMode,/);
    expect(CHAT, "the request still names the model").not.toMatch(/\{\s*model:\s*accountModel/);
    expect(CHAT).toMatch(/resolveAssistantConfig|config\.mode/);
    expect(CHAT_ROUTE).toContain("resolveAssistantConfig");
    // The route reads the stored row and decides from it.
    expect(CHAT_ROUTE).toMatch(/const stored = await getAssistantSettings\(me\.id\);/);
    expect(CHAT_ROUTE).toMatch(/const config = resolveAssistantConfig\(stored\);/);
  });

  it("and neither the mode nor the account model is component state", () => {
    // The two halves of "a refresh loses what I chose". Both were `useState`,
    // and both were the only copy — a saved row and a forgotten one at the same
    // time, which is how the assistant looked configured while answering with
    // a model nobody had picked.
    //
    // Anchored on the destructuring, not on the words: the legitimate lines
    // also mention both names, as `const credentialMode = config.mode`.
    expect(CHAT, "the mode is state again").not.toMatch(
      /const \[\s*(?:accountModel|credentialMode)\s*,\s*set/,
    );
    expect(CHAT).toMatch(/const credentialMode = config\.mode;/);
  });

  it("and the two new fields are added to an existing deployment", () => {
    // Nullable columns in the fresh schema only would mean a deployment that
    // already has rows never gets them, so the save would write to columns that
    // do not exist. Both go through ADDED_COLUMNS for exactly that reason.
    const sqlite = read("lib/db/sqlite.ts");
    for (const column of ["credential_mode", "account_model"]) {
      expect(sqlite, `${column} is only in the fresh schema`).toContain(
        `{ table: "assistant_settings", column: "${column}"`,
      );
    }
  });

  it("and there is no auto-pick anywhere on the account path", () => {
    // The single line that made an unconfigured assistant work:
    // `accountModel = allowed[0] ?? null`. It answered a turn with a model
    // nobody chose, which is indistinguishable from a saved setting.
    // Anchored to an assignment, not the bare text: the comment above records
    // that `allowed[0]` used to be the answer, and a guard that matched the
    // sentence explaining the fix would be a guard that could never pass.
    expect(CHAT_ROUTE, "something still picks the first available model").not.toMatch(
      /=\s*allowed\[0\]/,
    );
    expect(CHAT_ROUTE).not.toMatch(/accountModelAuto/);
    // A model is required, and the refusal names the field.
    expect(CHAT_ROUTE).toMatch(/if \(!config\.ready\) \{/);
    expect(CHAT_ROUTE).toMatch(/code: "not_configured"/);
    // The rule itself is tested by calling it, not by reading it:
    // `assistant-config.test.ts` pins that an unconfigured row resolves to no
    // model at all, which is the property this whole file is guarding.
    expect(CONFIG).toContain("export function resolveAssistantConfig");
  });

  it("the account turn still runs through the proxy, not over HTTP with a key", () => {
    expect(CHAT_ROUTE, "the account path still dials an address").toMatch(
      /function accountTransport\([\s\S]{0,900}proxyChatCompletion\(\{/,
    );
    expect(CHAT_ROUTE).toMatch(/transport: accountTransport\(credential\.account\)/);
    // And the client takes that as an alternative to the fetch, not instead of
    // the streaming assembly — the two paths must not become two clients.
    expect(CLIENT).toContain("export type UpstreamTransport");
    expect(CLIENT).toMatch(/if \(opts\.transport\) \{[\s\S]{0,400}opts\.transport\(\{ body, signal/);
    expect(CLIENT).toMatch(/return await readTurn\(stream, opts\.onText\)/);
  });

  it("the model on that path is checked, not trusted", () => {
    // The list is a policy decision — the key's whitelist and which providers
    // are enabled — and neither a request body nor a form is where that is
    // enforced. A model that has since been withdrawn is a setting to fix, said
    // as such, rather than quietly replaced.
    expect(CHAT_ROUTE).toMatch(/listClientModelIds\(credential\.account\.apiKey\)/);
    expect(CHAT_ROUTE).toMatch(/allowed\.includes\(config\.model\)/);
    expect(CHAT_ROUTE).toMatch(/code: "model_not_allowed"/);
  });

  it("and the composer follows the same one rule the route uses", () => {
    // Was `configured` and `missingModel` computed here from two props, which
    // is how a stored row with a blank model looked configured. Now there is
    // one value, computed on the server by the same resolver.
    expect(CHAT).toMatch(/const canSend = config\.ready;/);
    expect(CHAT).not.toMatch(/const missingModel = /);
    expect(CHAT).not.toMatch(/const configured\b/);
    expect(CHAT).toMatch(/busy \|\| !canSend\) return;/);
    expect(CHAT).toMatch(/\{missingUpstream && \(/);
  });

  it("and the model answering is named on screen, with no fallback", () => {
    // "Which model is this" decides what the answer is worth. With nothing
    // chosen it says nothing chosen — the old fallback named a model nobody
    // picked, which is worse than naming none.
    expect(CHAT).toMatch(/const effectiveModelLabel = config\.model \|\|/);
    expect(CHAT).not.toContain("assistant.accountModelAuto");
  });

  it("the account path says what it needs, instead of failing quietly", () => {
    // "Use my account identity" spends no secret at any point, but it does need
    // a switch turned on — and that switch lives in the settings screen, not
    // here. The form offered the option silently, so choosing it appeared to do
    // nothing and the only configuration that worked was somebody else's key.
    // That is what "why does identity auth still need a key" turned out to be.
    expect(SETTINGS_PANEL_SRC, "the form does not read the credential state").toMatch(
      /useCredentialStore\(\)/,
    );
    // …and the warning is *gated on it*. A hardcoded `{created: true, enabled:
    // true}` would leave every string in place and every assertion here
    // satisfied, which is how a warning that never fires gets shipped.
    expect(SETTINGS_PANEL_SRC).toMatch(/const accountUsable = credentialState\.created && credentialState\.enabled;/);
    expect(SETTINGS_PANEL_SRC).toMatch(/\{mode === "account" && !accountUsable && \(/);
    expect(SETTINGS_PANEL_SRC, "the warning has no destination").toContain(
      "assistant.settings.wayAccountGo",
    );
    // And the route refuses the "neither" credential on the account path,
    // rather than falling through and treating it as the key path.
    expect(CHAT_ROUTE).toMatch(
      /if \(config\.mode === "account" && credential\.kind === "none"\) \{/,
    );
    expect(CHAT_ROUTE).toMatch(/code: "no_credential"/);
    // …and only there: on the key path the turn spends the caller's own stored
    // upstream key and never touches a relay key, so refusing there would fail a
    // plain message because an unrelated switch was off.
    expect(CHAT_ROUTE, "the key path is refused for a missing tool credential").not.toMatch(
      /if \(credential\.kind === "none"\) \{/,
    );
    // The refusal has to point at the account credential — that is the thing the
    // reader has to go and do. Mentioning the other path as an alternative is
    // fine and useful; claiming a key is *required* is the bug, so the assertion
    // is on the destination rather than on a banned word.
    const noCredential = CHAT_ROUTE.slice(
      CHAT_ROUTE.indexOf('if (config.mode === "account" && credential.kind === "none")'),
      CHAT_ROUTE.indexOf('if (config.mode === "account" && credential.kind === "none")') + 900,
    );
    expect(noCredential, "the refusal does not say which option is unavailable").toContain(
      "账号身份",
    );
    expect(noCredential, "the refusal does not send them to the switch").toContain("设置");
    // And the form says the same thing before they send anything.
    expect(SETTINGS_PANEL_SRC).toContain("assistant.settings.wayAccountOff");
  });

  it("and no key field is rendered on the account path", () => {
    // The fields live in the other half of a ternary, so the check is on the
    // branch rather than on the presence of the label — a key field somewhere
    // below the mode switch would still read as "identity auth needs a key".
    const accountBranch = SETTINGS_PANEL_SRC.slice(
      SETTINGS_PANEL_SRC.indexOf('mode === "account" ?'),
    );
    const keyBranch = accountBranch.slice(0, accountBranch.indexOf(") : ("));
    expect(keyBranch, "the account branch has a key field in it").not.toContain(
      "assistant.settings.apiKey",
    );
    expect(keyBranch, "the account branch has an address field in it").not.toContain(
      "assistant.settings.baseUrl",
    );
    // The condition itself, because inverting it puts the key form in front of
    // somebody who chose the account path while leaving both branches intact —
    // which is the version of this bug that a per-branch check cannot see.
    expect(SETTINGS_PANEL_SRC).toMatch(/\{mode === "account" \? \(/);
    // …and the key path still has both.
    expect(SETTINGS_PANEL_SRC.slice(SETTINGS_PANEL_SRC.indexOf(") : ("))).toContain(
      "assistant.settings.apiKey",
    );
  });

  it("and the thinking level is stored, sent, and not defaulted", () => {
    const sqlite = read("lib/db/sqlite.ts");
    const client = read("lib/assistant/client.ts");
    const configSrc = read("lib/assistant/config.ts");

    // On the wire under the name the API uses, and only when chosen.
    expect(client).toContain("reasoning_effort");
    expect(client).toMatch(
      /opts\.reasoningEffort !== undefined \? \{ reasoning_effort: opts\.reasoningEffort \}/,
    );
    // Stored on an existing deployment, not just in the fresh schema.
    expect(sqlite).toContain('{ table: "assistant_settings", column: "reasoning_effort"');
    // The blank option is its own answer rather than the lowest level.
    expect(SETTINGS_PANEL_SRC, "the blank option is missing").toContain(
      "assistant.settings.reasoningOff",
    );
    expect(SETTINGS_PANEL_SRC).toMatch(/e\.target\.value === "" \? null :/);
    // The closed list is shared with the validator rather than retyped: a form
    // that spelled the levels out would drift from what the API accepts. Matched
    // on the use, because an import nothing renders documents nothing.
    expect(SETTINGS_PANEL_SRC).toMatch(/ASSISTANT_REASONING_SUGGESTIONS\.map\(/);
    // …and the free-text half, which is the part that makes the list safe: a
    // vendor's own word for a level has to survive being typed.
    expect(SETTINGS_PANEL_SRC).toMatch(/assistant\.settings\.reasoningCustomPlaceholder/);
    expect(SETTINGS_PANEL_SRC).toMatch(/e\.target\.value === CUSTOM_EFFORT/);
    expect(configSrc).toMatch(/params\.reasoningEffort != null/);
  });

  it("and the account path fills the model's own numbers from the catalogue", () => {
    // The account path runs on this deployment's models, whose window and output
    // cap are already in the provider table. Asking the user to type the same
    // two numbers is the form treating a fact it holds as a blank — and a
    // mistyped window silently truncates the conversation.
    expect(SETTINGS_PANEL_SRC).toContain("accountFacts");
    expect(SETTINGS_PANEL_SRC).toMatch(
      /function chooseAccountModel\(next: string\)[\s\S]{0,400}?setContextLength\(known\.contextLength\)/,
    );
    expect(SETTINGS_PANEL_SRC).toMatch(/setMaxOutputTokens\(known\.maxOutputTokens\)/);
    // The page is where the facts come from, read live from the same source the
    // proxy enforces.
    const page = read("app/(user)/dashboard/assistant/page.tsx");
    expect(page).toContain("accountFacts");
    expect(page).toMatch(/accountFacts\[m\.id\] = \{ contextLength: m\.contextLength/);
  });

  it("and the account path still needs its upstream, and still says so", () => {
    // Nothing about the key path was relaxed. Without an address or a key it is
    // 409, and the form still asks for them on that path.
    expect(CONFIG, "the key path no longer requires an upstream").toMatch(
      /mode === "key"[\s\S]{0,200}no-upstream/,
    );
    expect(CONFIG, "the key path no longer requires a key").toMatch(
      /mode === "key"[\s\S]{0,320}no-key/,
    );
    expect(SETTINGS_PANEL_SRC, "the upstream key field is gone").toContain(
      "assistant.settings.apiKey",
    );
    expect(SETTINGS_PANEL_SRC, "the address field is gone").toContain(
      "assistant.settings.baseUrl",
    );
  });
});
