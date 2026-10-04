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
import { resolveMode, type AssistantCredentialMode } from "@/lib/assistant/config";

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
}

export function AssistantSettingsPanel({
  initial,
  suggestedModels = [],
  accountModels = [],
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
}) {
  const t = useT();
  const router = useRouter();
  const modeGroup = `${useId()}-mode`;

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
        <legend className="mb-1.5 text-sm font-medium text-foreground">
          {t("assistant.settings.wayTitle")}
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
            onChange={(e) => setAccountModel(e.target.value)}
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
            id="assistant-max-output"
            label={t("assistant.settings.maxOutput")}
            wire="max_tokens"
            min={1}
            value={maxOutputTokens}
            onChange={setMaxOutputTokens}
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
        <p className="mt-2.5 text-xs text-muted-foreground">
          {t("assistant.settings.modelParamsHint")}
        </p>
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
