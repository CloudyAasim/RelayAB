"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { FormFooter, FormStatus } from "@/components/ui/FormStatus";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useT } from "@/components/i18n/I18nProvider";
import {
  canonicalMediaProviderMode,
  MEDIA_PROVIDER_UI_MODES,
  type MediaProviderMode,
  type MediaProviderUiMode,
} from "@/lib/media/spec";
import { Save } from "lucide-react";

export interface MediaTemplate {
  id: string;
  name: string;
  baseUrl: string;
  models: unknown;
  specs: unknown;
}

export type { MediaProviderMode };

export interface MediaProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  /** How the provider is spoken to; see the mode select below. */
  mode?: MediaProviderMode;
  passthroughPaths?: string[];
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
  /**
   * The row may carry a legacy value (`advanced` / `simple` / `restricted`) that
   * the two-option select cannot show; fold it onto the mode it behaves as.
   */
  const [mode, setMode] = useState<MediaProviderUiMode>(
    canonicalMediaProviderMode(provider?.mode ?? "spec"),
  );
  const [passthroughPaths, setPassthroughPaths] = useState(
    (provider?.passthroughPaths ?? []).join("\n"),
  );
  /**
   * A passthrough provider has no spec: there is no translation, so the JSON
   * editor is not a field it can use. Showing it invited people to write a spec
   * that would never be read.
   */
  const usesSpecs = mode === "spec";
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
        mode,
        passthroughPaths: passthroughPaths
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
        models: JSON.parse(models),
        // Sending `specs` from a passthrough form would overwrite the stored
        // specs with whatever is left in a hidden box; omitting them keeps the
        // row intact if the operator switches back.
        ...(usesSpecs ? { specs: JSON.parse(specs) } : {}),
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
      {/* Same two-column first row as the normal provider form: identity, then
          how this vendor is addressed. */}
      <div className="grid grid-cols-2 gap-4">
        <Input
          label={t("admin.mediaProviders.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          id="media-provider-mode"
          label={t("admin.mediaProviders.mode")}
          value={mode}
          onChange={(e) => setMode(e.target.value as MediaProviderUiMode)}
          hint={t(
            mode === "spec"
              ? "admin.mediaProviders.mode.specBody"
              : "admin.mediaProviders.mode.passthroughBody",
          )}
        >
          {MEDIA_PROVIDER_UI_MODES.map((value) => (
            <option key={value} value={value}>
              {t(`admin.mediaProviders.mode.${value}`)}
            </option>
          ))}
        </Select>
      </div>

      <Input
        label={t("admin.mediaProviders.baseUrl")}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://api.example.com"
      />

      <Input
        label={
          editing
            ? `${t("admin.mediaProviders.apiKey")} (${t("admin.providers.edit.leaveBlank")})`
            : t("admin.mediaProviders.apiKey")
        }
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={editing ? "••••••" : ""}
      />

      <div className="grid grid-cols-2 gap-4">
        <Input
          label={t("admin.mediaProviders.priority")}
          type="number"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <label
          htmlFor="media-provider-enabled"
          className="flex items-center gap-2 pt-6 text-sm"
        >
          <Switch
            id="media-provider-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
          {t("dashboard.status.enabled")}
        </label>
      </div>

      {mode === "passthrough" && (
        <Textarea
          label={t("admin.mediaProviders.passthroughPaths")}
          hint={t("admin.mediaProviders.passthroughPaths.hint")}
          value={passthroughPaths}
          onChange={(e) => setPassthroughPaths(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={"/v1/videos\n/v1/images/edits"}
        />
      )}

      <Textarea
        label={t("admin.mediaProviders.models")}
        value={models}
        onChange={(e) => setModels(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={'{\n  "image-01": { "upstreamId": "image-01", "pricePerItem": 2, "enabled": true }\n}'}
      />

      {usesSpecs && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="block text-sm font-medium text-foreground">
              {t("admin.mediaProviders.specs")}
            </label>
            {templates &&
              !editing &&
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
          </div>
          <Textarea
            value={specs}
            onChange={(e) => setSpecs(e.target.value)}
            rows={12}
            spellCheck={false}
          />
        </div>
      )}

      <FormStatus error={error} saved={saved} savedText={t("admin.mediaProviders.saved")} />

      <FormFooter>
        <Button type="button" loading={busy} onClick={save}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </FormFooter>
    </div>
  );
}