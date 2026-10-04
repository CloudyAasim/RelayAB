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

export interface AssistantSettingsView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
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
  const [apiKey, setApiKey] = useState("");
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
          A text field with suggestions, not a select.

          This value is sent as typed, alongside the base URL and key beside it,
          to an upstream the operator chose — so an id this deployment has never
          heard of is a legitimate thing to type, and closing the field would
          make it unreachable. The list is what `测试连通` last reported, which
          is what the probe was fetching it for.
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

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={probe}
            disabled={busy !== null || !baseUrl.trim() || !apiKey.trim()}
          >
            {busy === "probe" ? t("assistant.settings.probing") : t("assistant.settings.probe")}
          </Button>
          <Button onClick={save} disabled={busy !== null || !baseUrl.trim() || !model.trim()}>
            {busy === "save" ? t("assistant.settings.saving") : t("assistant.settings.save")}
          </Button>
        </div>

      {message && (
        <p className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
