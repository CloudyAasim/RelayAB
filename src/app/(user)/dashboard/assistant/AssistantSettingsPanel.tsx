"use client";

/**
 * app/(user)/dashboard/assistant/AssistantSettingsPanel.tsx
 *
 * Configure which upstream the assistant runs on, using the caller's own key.
 *
 * Two behaviours worth calling out:
 *
 *  - **Probe before save.** A wrong base URL is discovered at the first message
 *    otherwise, which reads as "the assistant is broken". `POST` to the same
 *    route checks it without writing anything.
 *  - **Blank key keeps the stored one.** Saving a changed model therefore never
 *    requires the browser to hold the key again, and a lost key is visible as
 *    "已配置" rather than as a silently cleared field.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { ModelCombobox } from "./ModelCombobox";

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
}: {
  initial: AssistantSettingsView | null;
  /**
   * Models to offer before anything is probed.
   *
   * Without these the field has a datalist and no entries, which looks exactly
   * like no dropdown at all. The probe's own list replaces them when it runs —
   * it is the authoritative answer for this key, these are only a starting
   * list.
   */
  suggestedModels?: string[];
}) {
  const t = useT();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  /**
   * A stored model this deployment has never heard of is exactly the case the
   * custom field exists for, and it is the common one: the assistant runs on the
   * caller's own upstream, so its models are usually not the gateway's. The
   * picker therefore starts in custom mode whenever the stored value is not on
   * the list, which is what the combo decides for itself.
   */
  const [apiKey, setApiKey] = useState("");
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
   * the other eleven. The field stays a text box — it is sent as typed, with
   * the base URL and key next to it, so an id this list does not know is still
   * a legitimate thing to type — and the list becomes the dropdown the browser
   * offers while you type.
   */
  const [knownModels, setKnownModels] = useState<string[]>(suggestedModels);

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
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          // Omitted entirely when blank: the server keeps the stored key.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          // Always sent, `null` included. Omitting a cleared box would leave
          // the stored value in place, so the form would look like it had
          // forgotten rather than cleared.
          contextLength,
          maxOutputTokens,
          temperature,
          topP,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (json?.ok) {
        setMessage({ ok: true, text: t("assistant.settings.saved") });
        setApiKey("");
        // The chat's "not configured" banner is server-rendered from the same
        // row, so a refresh is what makes it go away.
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

  return (
    // No Card wrapper: this lives inside a drawer that already has a title and
    // a description, so a card around it would just be a box in a box.
    <div className="space-y-4">
      <Input
        label={t("assistant.settings.baseUrl")}
          hint={t("assistant.settings.baseUrlHint")}
          placeholder="https://api.example.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Input
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
        {/*
          The one thing this form decides: which model. A text field with a
          picker, because the model is the caller's own and this deployment has
          usually never heard of it — a closed list would refuse the only model
          they actually have.
        */}
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
        {/*
          The model's own parameters. Every one of them is optional, and leaving
          one blank is a real choice — the upstream's own default — not a gap in
          the form. Which is why they are not defaulted here: a temperature I
          picked is a temperature I chose for somebody's model.
        */}
        <fieldset className="grid grid-cols-2 gap-3 rounded-md border border-border p-3 sm:grid-cols-4">
          <legend className="px-1 text-xs text-muted-foreground">
            {t("assistant.settings.modelParams")}
          </legend>
          <Input
            id="assistant-context-length"
            name="contextLength"
            type="number"
            min={1}
            label={t("assistant.settings.contextLength")}
            hint={t("assistant.settings.contextLengthHint")}
            value={contextLength === null ? "" : String(contextLength)}
            onChange={(e) => setContextLength(blankToNull(e.target.value))}
          />
          <Input
            id="assistant-max-output"
            name="maxOutputTokens"
            type="number"
            min={1}
            label={t("assistant.settings.maxOutput")}
            hint={t("assistant.settings.maxOutputHint")}
            value={maxOutputTokens === null ? "" : String(maxOutputTokens)}
            onChange={(e) => setMaxOutputTokens(blankToNull(e.target.value))}
          />
          <Input
            id="assistant-temperature"
            name="temperature"
            type="number"
            min={0}
            max={2}
            step="0.1"
            label={t("assistant.settings.temperature")}
            hint={t("assistant.settings.temperatureHint")}
            value={temperature === null ? "" : String(temperature)}
            onChange={(e) => setTemperature(blankToNull(e.target.value))}
          />
          <Input
            id="assistant-top-p"
            name="topP"
            type="number"
            min={0}
            max={1}
            step="0.05"
            label={t("assistant.settings.topP")}
            hint={t("assistant.settings.topPHint")}
            value={topP === null ? "" : String(topP)}
            onChange={(e) => setTopP(blankToNull(e.target.value))}
          />
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={probe}
            disabled={busy !== null || !baseUrl.trim() || !apiKey.trim()}
          >
            {busy === "probe" ? t("assistant.settings.probing") : t("assistant.settings.probe")}
          </Button>
          {/*
            A model is required, so the button says so instead of letting a save
            go out and come back as a validation error. The API has always
            required it; what was missing was the form agreeing with it.
          */}
          <Button
            onClick={save}
            disabled={busy !== null || !baseUrl.trim() || !model.trim()}
            title={model.trim() ? undefined : t("assistant.settings.pickAModel")}
          >
            {busy === "save" ? t("assistant.settings.saving") : t("assistant.settings.save")}
          </Button>
        </div>
        {!model.trim() && (
          <p className="text-xs text-muted-foreground">{t("assistant.settings.pickAModel")}</p>
        )}

      {message && (
        <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
