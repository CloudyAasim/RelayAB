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

export interface AssistantSettingsView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export function AssistantSettingsPanel({ initial }: { initial: AssistantSettingsView | null }) {
  const t = useT();
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"probe" | "save" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

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
        if (probe.ok && probe.models.length > 0 && !model.trim()) setModel(probe.models[0]);
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
    <Card>
      <CardHeader title={t("assistant.settings.title")} description={t("assistant.settings.desc")} />
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
        <Input
          label={t("assistant.settings.model")}
          placeholder="model-name"
          value={model}
          onChange={(e) => setModel(e.target.value)}
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
          <p
            className={`text-sm ${message.ok ? "text-muted-foreground" : "text-destructive"}`}
          >
            {message.text}
          </p>
        )}
      </div>
    </Card>
  );
}
