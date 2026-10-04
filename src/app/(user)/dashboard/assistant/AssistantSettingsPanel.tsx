"use client";

/**
 * app/(user)/dashboard/assistant/AssistantSettingsPanel.tsx
 *
 * The assistant's configuration, in one form.
 *
 * **Why this is one form and not a switch plus two panels.** It used to be a
 * mode switch in the chat, a model dropdown beside it, and a settings form that
 * was only rendered on the key path — three controls for two settings, two of
 * them never saved, and the account path with no way to configure it at all.
 * Every one of them is here now: pick how the assistant is paid for, say which
 * model answers, say what that model's parameters are, and it survives a
 * refresh because the server stores it.
 *
 * **Narrow by design.** This lives in a 384px drawer. The parameter group used
 * to be a four-column grid, which at this width is four ~80px inputs with their
 * labels wrapping onto three lines each. It is two columns here, and the wire
 * name of each parameter sits under its Chinese name rather than beside it, so
 * the reader gets a consistent language and still learns what to look for in
 * their vendor's documentation.
 */
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { ModelCombobox } from "./ModelCombobox";
import {
  ASSISTANT_REASONING_SUGGESTIONS,
  resolveMode,
  type AssistantCredentialMode,
  type AssistantReasoningEffort,
} from "@/lib/assistant/config";
import { useCredentialStore } from "@/lib/assistant/credential-store";

const CUSTOM_EFFORT = "__custom_effort__";

/**
 * Empty box → null ("do not send"), and never NaN.
 *
 * `Number("")` is 0, which here would be a temperature of zero — a real and
 * very different setting from "unset". Every one of these four treats a blank
 * as an instruction, not as a value.
 */
function blankToNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface AssistantModelFacts {
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** The thinking levels this model's vendor publishes. Empty = said nothing. */
  reasoningLevels: string[];
}

export interface AssistantSettingsView {
  baseUrl: string;
  model: string;
  accountModel: string | null;
  credentialMode: AssistantCredentialMode | null;
  hasApiKey: boolean;
  /** The model's own parameters. `null` is "not configured" and is sent as such. */
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  reasoningEffort?: AssistantReasoningEffort | null;
}

export function AssistantSettingsPanel({
  initial,
  suggestedModels = [],
  accountModels = [],
  accountFacts = {},
}: {
  initial: AssistantSettingsView | null;
  /**
   * Models to offer on the key path before anything is probed.
   *
   * Without these the field has a datalist and no entries, which looks exactly
   * like no dropdown at all. The probe's own list replaces them when it runs —
   * it is the authoritative answer for this key, these are only a starting
   * list.
   */
  suggestedModels?: string[];
  /** This deployment's own chat models: the only choices on the account path. */
  accountModels?: string[];
  /**
   * What this deployment has configured for each of its own models.
   *
   * The account path runs on models whose window and output cap are already
   * known — the operator typed them into the provider table when they added the
   * model. Asking the user to type the same two numbers again is the form
   * treating a fact it has as a blank.
   */
  accountFacts?: Record<string, AssistantModelFacts>;
}) {
  const t = useT();
  const router = useRouter();
  const modeGroup = `${useId()}-mode`;

  /**
   * Whether the account path can actually spend anything.
   *
   * Read from the same store the settings screen writes, so the two cannot
   * disagree about whether the switch is on. The state arrives after mount, so
   * "not loaded yet" is its own answer and says so rather than flashing a
   * warning at somebody whose credential is fine.
   */
  const { data: credentialState, loaded: credentialLoaded } = useCredentialStore();
  const accountUsable = credentialState.created && credentialState.enabled;

  // The mode comes from the stored row, through the same rule the page and the
  // chat route use. No row at all means the account path, because that is the
  // one that needs nothing but a model.
  const [mode, setMode] = useState<AssistantCredentialMode>(() =>
    resolveMode(initial as Parameters<typeof resolveMode>[0]),
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.model ?? "");
  const [accountModel, setAccountModel] = useState(initial?.accountModel ?? "");
  // Seeded from the stored row as `null`, never `0`: a blank box means "do not
  // send this", and a 0 would be a temperature somebody chose.
  const [contextLength, setContextLength] = useState<number | null>(initial?.contextLength ?? null);
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | null>(initial?.maxOutputTokens ?? null);
  const [temperature, setTemperature] = useState<number | null>(initial?.temperature ?? null);
  const [topP, setTopP] = useState<number | null>(initial?.topP ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<AssistantReasoningEffort | null>(
    initial?.reasoningEffort ?? null,
  );
  const [busy, setBusy] = useState<"probe" | "save" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  /**
   * What the upstream last said it serves, as suggestions for the model field.
   *
   * The probe was already fetching these and then dropping them on the floor
   * bar one: it set the field to the first id and kept nothing else, so a
   * vendor with twelve models gave the operator one choice and no way to see
   * the other eleven.
   */
  const [knownModels, setKnownModels] = useState<string[]>(suggestedModels);

  /**
   * Re-seed from the server after a save.
   *
   * Without this the form keeps whatever it last held, which is how a value the
   * server rejected or normalised stays on screen looking saved. `initial` is
   * only read when it is a genuinely different object, so typing is not fought
   * over by an effect.
   */
  const [seed, setSeed] = useState(initial);
  useEffect(() => {
    if (seed === initial) return;
    setSeed(initial);
    if (!initial) return;
    setMode(resolveMode(initial as Parameters<typeof resolveMode>[0]));
    setBaseUrl(initial.baseUrl ?? "");
    setModel(initial.model ?? "");
    setAccountModel(initial.accountModel ?? "");
    setContextLength(initial.contextLength ?? null);
    setMaxOutputTokens(initial.maxOutputTokens ?? null);
    setTemperature(initial.temperature ?? null);
    setTopP(initial.topP ?? null);
  }, [initial, seed]);

  /** Everything the form knows, in the shape the route takes. */
  function payload() {
    return {
      credentialMode: mode,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      accountModel: mode === "account" ? (accountModel.trim() || null) : null,
      // Omitted entirely when blank: the server keeps the stored key.
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      // Always sent, `null` included. Omitting a cleared box would leave the
      // stored value in place, so the form would look like it had forgotten
      // rather than cleared.
      contextLength,
      maxOutputTokens,
      temperature,
      topP,
      reasoningEffort,
    };
  }

  async function probe() {
    if (!baseUrl.trim() || !apiKey.trim()) {
      setMessage({ ok: false, text: t("assistant.settings.probeNeedsKey") });
      return;
    }
    setBusy("probe");
    setMessage(null);
    try {
      const res = await fetch("/api/assistant/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() }),
      });
      const json = (await res.json().catch(() => null)) as
        | { data?: { probe?: { ok: boolean; models: string[]; status: number; error?: string } } }
        | { error?: { message?: string } }
        | null;

      const probe = (json as { data?: { probe?: { ok: boolean; models: string[]; status: number; error?: string } } })?.data?.probe;
      if (probe) {
        setMessage(
          probe.ok
            ? { ok: true, text: `${t("assistant.settings.probeOk")} (${probe.models.length})` }
            : { ok: false, text: `${t("assistant.settings.probeFail")} HTTP ${probe.status}: ${probe.error ?? ""}` },
        );
        if (probe.ok && probe.models.length > 0) {
          setKnownModels(probe.models);
          if (!model.trim()) setModel(probe.models[0]);
        }
      } else {
        setMessage({
          ok: false,
          text: (json as { error?: { message?: string } })?.error?.message ?? "probe failed",
        });
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setMessage(null);
    try {
      const res = await fetch("/api/assistant/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; data?: { settings: AssistantSettingsView | null }; error?: { message?: string } }
        | null;
      if (json?.ok) {
        setMessage({ ok: true, text: t("assistant.settings.saved") });
        setApiKey("");
        // The server's own answer, not the form's: a value it normalised or a
        // field it filled in should be what the next render shows.
        setSeed(json.data?.settings ?? null);
        // The chat's model label and send button are rendered from the same row
        // on the server, so a refresh is what makes them move.
        router.refresh();
      } else {
        setMessage({ ok: false, text: json?.error?.message ?? "save failed" });
      }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const missingModel = mode === "account" ? !accountModel.trim() : !model.trim() || !baseUrl.trim();
  const canSave = busy === null && !missingModel;

  /**
   * Fill the two numbers this deployment already knows about the chosen model.
   *
   * The account path runs on this deployment's own models, and the operator
   * typed their window and output cap into the provider table when they added
   * them. Asking the user for the same two numbers again is a form treating a
   * fact it is holding as a blank — and a mistyped window is not a harmless
   * mistake, it silently truncates the conversation.
   *
   * Only on the account path, and only for the two fields the catalogue knows.
   * The sampling parameters stay blank on purpose: those are the user's choice
   * and no deployment has an opinion about them.
   */
  const facts = accountFacts[accountModel.trim()];
  function chooseAccountModel(next: string) {
    setAccountModel(next);
    const known = accountFacts[next.trim()];
    if (!known) return;
    setContextLength(known.contextLength);
    setMaxOutputTokens(known.maxOutputTokens);
  }

  return (
    // No Card wrapper: this lives inside a drawer that already has a title and
    // a description, so a card around it would just be a box in a box.
    <div className="space-y-4">
      {/*
        The one decision that changes what the fields below mean. Two equal
        halves rather than a list of radio rows: at 384px a full-width row per
        option puts three lines of prose between the reader and the two fields
        that matter, and the prose is the same on both sides.
      */}
      <fieldset>
        <legend className="mb-1.5 flex items-baseline justify-between gap-2 text-sm font-medium text-foreground">
          {t("assistant.settings.wayTitle")}
          {/*
            Which one is actually in effect, in words.
            
            The two options differ by a border colour, and the report this answers
            was somebody reading a key field and concluding that identity auth
            needs one — while they were, correctly, on the other option. A row
            written before the mode existed reads as the key path, because it
            does have an address and a key in it, so opening on the other option
            is the right behaviour and an unexplained one. Saying it is cheaper
            than a screenshot.
          */}
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {mode === "account"
              ? t("assistant.settings.wayActiveAccount")
              : t("assistant.settings.wayActiveKey")}
          </span>
        </legend>
        <div className="grid grid-cols-2 gap-1.5" role="none">
          {(["account", "key"] as const).map((m) => (
            <label
              key={m}
              className={`cursor-pointer rounded-md border px-2.5 py-2 text-sm transition-colors ${
                mode === m
                  ? "border-primary bg-primary/5 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/50"
              }`}
            >
              <input
                type="radio"
                name={modeGroup}
                className="sr-only"
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              {m === "account"
                ? t("assistant.settings.wayAccount")
                : t("assistant.settings.wayKey")}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {mode === "account"
            ? t("assistant.settings.wayAccountHint")
            : t("assistant.settings.wayKeyHint")}
        </p>
        {/*
          The one thing that made "use my account identity" look like it needed a
          key.

          That path spends no secret at any point — it runs through this
          deployment with a credential the system issues and the user never
          sees. But it does need a switch turned on, and that switch is in the
          settings screen, not here. The form offered the option silently, so
          choosing it appeared to do nothing and the only configuration that
          worked was somebody else's key. So the state is read here and said out
          loud, with the place that changes it.
        */}
        {mode === "account" && !accountUsable && (
          <p className="mt-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            {credentialLoaded
              ? t("assistant.settings.wayAccountOff")
              : t("assistant.settings.wayAccountLoading")}
            {" "}
            <a href="/dashboard/settings" className="underline underline-offset-2">
              {t("assistant.settings.wayAccountGo")}
            </a>
          </p>
        )}
      </fieldset>

      {mode === "account" ? (
        <div className="space-y-1.5">
          <label
            htmlFor="assistant-account-model"
            className="block text-sm font-medium text-foreground"
          >
            {t("assistant.settings.accountModel")}
          </label>
          <select
            id="assistant-account-model"
            value={accountModel}
            onChange={(e) => chooseAccountModel(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">{t("assistant.settings.accountModelNone")}</option>
            {accountModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t("assistant.settings.accountModelHint")}
          </p>
        </div>
      ) : (
        <>
          <Input
            id="assistant-base-url"
            name="baseUrl"
            label={t("assistant.settings.baseUrl")}
            hint={t("assistant.settings.baseUrlHint")}
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <Input
            id="assistant-api-key"
            name="apiKey"
            label={t("assistant.settings.apiKey")}
            hint={
              initial?.hasApiKey
                ? t("assistant.settings.apiKeyConfigured")
                : t("assistant.settings.apiKeyHint")
            }
            type="password"
            autoComplete="off"
            placeholder={initial?.hasApiKey ? "••••••••" : "sk-..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <ModelCombobox
            id="assistant-model"
            label={t("assistant.settings.model")}
            customLabel={t("assistant.settings.modelCustom")}
            placeholder="model-name"
            value={model}
            options={knownModels}
            onChange={setModel}
            hint={
              knownModels.length > 0 && knownModels !== suggestedModels
                ? t("assistant.settings.modelHintProbed", { n: knownModels.length })
                : t("assistant.settings.modelHint")
            }
          />
        </>
      )}

      {/*
        The model's own parameters, on both paths. They belong to the model the
        person chose rather than to the thing paying for it, and a setting that
        only works on one of the two is half a setting.

        Two columns, not four: this is a 384px drawer, and four columns of number
        inputs with their labels is the layout that made this form look thrown
        together. The wire name goes under the Chinese name so the row reads as
        one language and still says what to look up in the vendor's docs.
      */}
      <fieldset className="rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium text-foreground">
          {t("assistant.settings.modelParams")}
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label
              htmlFor="assistant-reasoning"
              className="block text-xs font-medium text-foreground"
            >
              {t("assistant.settings.reasoning")}
            </label>
            {/*
              A picker with a way out, and the way out is the point.
              
              The levels are published per model: some offer four, some three,
              some can be switched off entirely, and a model that does not think
              has none to publish. A closed list is therefore wrong for most of
              the models on a deployment, and wrong silently — the request
              carries a name the vendor either ignores or refuses. So the list is
              a suggestion and the field takes anything.
            */}
            <ReasoningCombobox
              id="assistant-reasoning"
              value={reasoningEffort}
              onChange={setReasoningEffort}
              levels={mode === "account" ? (facts?.reasoningLevels ?? []) : []}
            />
            <p className="font-mono text-[10px] text-muted-foreground">reasoning_effort</p>
          </div>
          <ParamField
            id="assistant-max-output"
            label={t("assistant.settings.maxOutput")}
            wire="max_tokens"
            min={1}
            value={maxOutputTokens}
            onChange={setMaxOutputTokens}
          />
        </div>

        {/*
          The sampling parameters, folded away.

          They change the shape of an answer rather than its length or its
          effort, they are the two everybody leaves at the vendor's default, and
          four boxes in a 384px drawer is four things to read past the two that
          matter. Open it when you mean it.
        */}
        <details className="mt-3 rounded-md border border-border/70 px-2.5 py-1.5">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground marker:hidden">
            {t("assistant.settings.advanced")}
          </summary>
          <div className="grid grid-cols-2 gap-3 pt-2.5">
            <ParamField
              id="assistant-temperature"
              label={t("assistant.settings.temperature")}
              wire="temperature"
              step="0.1"
              min={0}
              max={2}
              value={temperature}
              onChange={setTemperature}
            />
            <ParamField
              id="assistant-top-p"
              label={t("assistant.settings.topP")}
              wire="top_p"
              step="0.05"
              min={0}
              max={1}
              value={topP}
              onChange={setTopP}
            />
            <ParamField
              id="assistant-context-length"
              label={t("assistant.settings.contextLength")}
              wire="context_length"
              min={1}
              value={contextLength}
              onChange={setContextLength}
            />
          </div>
        </details>

        <p className="mt-2.5 text-xs text-muted-foreground">
          {t("assistant.settings.modelParamsHint")}
        </p>
        {/* Says where the two numbers came from, because "filled in by itself"
            and "you typed this" look identical in a box. */}
        {mode === "account" && facts && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("assistant.settings.filledFromDeployment")}
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        {mode === "key" && (
          <Button
            variant="outline"
            onClick={probe}
            disabled={busy !== null || !baseUrl.trim() || !apiKey.trim()}
          >
            {busy === "probe" ? t("assistant.settings.probing") : t("assistant.settings.probe")}
          </Button>
        )}
        <Button onClick={save} disabled={!canSave}>
          {busy === "save" ? t("assistant.settings.saving") : t("assistant.settings.save")}
        </Button>
      </div>

      {/* The button says why it is closed, rather than letting a save go out
          and come back as a validation error. The route has always required a
          model; what was missing was the form agreeing with it. */}
      {missingModel && (
        <p className="text-xs text-muted-foreground">
          {mode === "account"
            ? t("assistant.settings.pickAnAccountModel")
            : t("assistant.settings.pickAModel")}
        </p>
      )}

      {message && (
        <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}

/**
 * The thinking level: a list of suggestions and a field that takes anything.
 *
 * The same shape as the model picker, for the same reason. The levels belong to
 * the model, not to this system — four names on one vendor, three on the next,
 * an on/off switch on a third, and nothing at all on a model that does not
 * think. Suggesting is helpful; deciding is not ours to do.
 */
function ReasoningCombobox({
  id,
  value,
  onChange,
  levels,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /**
   * The levels this model's own vendor publishes, when the deployment knows.
   *
   * They replace the generic list rather than joining it: offering four names
   * the model does not take is the same mistake as having no picker at all, one
   * step further from the truth. Empty falls back to the common spellings,
   * because a suggestion list is still better than an empty box — and the field
   * beside it takes anything either way.
   */
  levels?: string[];
}) {
  const t = useT();
  const typed = (value ?? "").trim();
  const options = levels && levels.length > 0 ? levels : [...ASSISTANT_REASONING_SUGGESTIONS];
  const isCustom = typed !== "" && !options.includes(typed);
  const [custom, setCustom] = useState(isCustom);
  useEffect(() => {
    if (typed !== "" && !options.includes(typed)) setCustom(true);
  }, [typed, options.join(" ")]);

  return (
    <>
      <select
        id={id}
        name="reasoningEffort"
        value={custom ? CUSTOM_EFFORT : typed}
        onChange={(e) => {
          if (e.target.value === CUSTOM_EFFORT) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(e.target.value === "" ? null : e.target.value);
        }}
        className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">{t("assistant.settings.reasoningOff")}</option>
        {options.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
        <option value={CUSTOM_EFFORT}>
          {custom && typed ? `自定义：${typed}` : t("assistant.settings.reasoningCustom")}
        </option>
      </select>
      {custom && (
        <input
          id={`${id}-text`}
          type="text"
          autoComplete="off"
          placeholder={t("assistant.settings.reasoningCustomPlaceholder")}
          value={typed}
          onChange={(e) => onChange(e.target.value.trim() || null)}
          className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        />
      )}
    </>
  );
}

/**
 * One parameter: Chinese label, the name the API calls it underneath, and a
 * number input. Split out because four copies of a label/input/wire-name stack
 * is four chances to write one of them differently.
 */
function ParamField({
  id,
  label,
  wire,
  value,
  onChange,
  step,
  min,
  max,
}: {
  id: string;
  label: string;
  /** The key this becomes on the wire, shown so the two can be matched up. */
  wire: string;
  value: number | null;
  onChange: (value: number | null) => void;
  step?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={value === null ? "" : String(value)}
        onChange={(e) => onChange(blankToNull(e.target.value))}
        className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm tabular-nums"
      />
      <p className="font-mono text-[10px] text-muted-foreground">{wire}</p>
    </div>
  );
}
