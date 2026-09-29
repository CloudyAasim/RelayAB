"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";

export interface MediaTemplate {
  id: string;
  name: string;
  baseUrl: string;
  models: unknown;
  specs: unknown;
}

export interface MediaProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  models: Record<string, unknown>;
  specs: unknown[];
}

interface Props {
  /** Present → edit mode (PATCH); absent → create mode (POST). */
  provider?: MediaProviderRow;
  /** Starting points shown as buttons in create mode. */
  templates?: MediaTemplate[];
  onSaved?: () => void;
}

/**
 * Editor for one media provider and its declarative specs.
 *
 * Rendered inside a modal by both the create button and the row actions, so a
 * provider row stays collapsed in the table until you actually want to edit it.
 * This screen is the promise of the protocol made concrete: a vendor is a name,
 * a base URL and some JSON.
 */
export function MediaProviderForm({ provider, templates, onSaved }: Props) {
  const t = useT();
  const router = useRouter();
  const editing = Boolean(provider);

  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [priority, setPriority] = useState(String(provider?.priority ?? 1));
  const [models, setModels] = useState(JSON.stringify(provider?.models ?? {}, null, 2));
  const [specs, setSpecs] = useState(JSON.stringify(provider?.specs ?? [], null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function loadTemplate(template: MediaTemplate) {
    setName(template.name);
    setBaseUrl(template.baseUrl);
    setModels(JSON.stringify(template.models, null, 2));
    setSpecs(JSON.stringify(template.specs, null, 2));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const payload: Record<string, unknown> = {
        name,
        baseUrl,
        enabled,
        priority: Number(priority) || 1,
        models: JSON.parse(models),
        specs: JSON.parse(specs),
      };
      // Blank key in edit mode means "keep the stored one".
      if (apiKey || !editing) payload.apiKey = apiKey;

      const res = await fetch(
        editing
          ? `/api/admin/media-providers/${provider!.id}`
          : "/api/admin/media-providers",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        return;
      }
      setSaved(true);
      onSaved?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("admin.mediaProviders.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          label={t("admin.mediaProviders.baseUrl")}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
        />
      </div>

      <Input
        label={`${t("admin.mediaProviders.apiKey")} (${t("admin.providers.edit.leaveBlank")})`}
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={editing ? "••••••" : ""}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("admin.mediaProviders.priority")}
          type="number"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
          />
          {t("dashboard.status.enabled")}
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">
          {t("admin.mediaProviders.models")}
        </span>
        <textarea
          value={models}
          onChange={(e) => setModels(e.target.value)}
          rows={5}
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        />
        <span className="block text-xs text-muted-foreground">
          {t("admin.mediaProviders.modelsHint")}
        </span>
      </label>

      <label className="block space-y-1">
        <span className="flex flex-wrap items-center gap-3 text-sm font-medium text-foreground">
          {t("admin.mediaProviders.specs")}
          {templates && !editing &&
            templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => loadTemplate(template)}
                className="text-xs font-normal text-primary hover:underline"
              >
                {template.name}
              </button>
            ))}
        </span>
        <textarea
          value={specs}
          onChange={(e) => setSpecs(e.target.value)}
          rows={14}
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        />
        <span className="block text-xs text-muted-foreground">
          {t("admin.mediaProviders.specsHint")}
        </span>
      </label>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          {t("admin.mediaProviders.saved")}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" loading={busy} onClick={save}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
