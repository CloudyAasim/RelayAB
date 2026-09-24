"use client";

/**
 * src/app/(admin)/admin/providers/CreateProviderButton.tsx
 *
 * Provider creation modal with model configuration:
 *   - Template selection (OpenAI / Anthropic / Azure / MiniMax / etc.)
 *   - Auto-fetch models from upstream
 *   - Model mapping editor (client model → upstream model)
 *   - Model configuration (context length, output length, credit cost)
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { PROVIDER_TEMPLATES } from "@/lib/providers/templates";
import { ProviderFacesField, type ProviderFacesValue } from "./ProviderFacesField";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  mergeFetchedModels,
  newModelRow,
  rowsToPayload,
  type ProviderModelRow,
} from "./model-rows";
import { ProviderModelsEditor } from "./ProviderModelsEditor";

interface Props {
  onCreated?: () => void;
}

type Kind = "openai" | "anthropic" | "custom-openai";

export function CreateProviderButton({ onCreated }: Props) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Form state
  const [templateId, setTemplateId] = useState("openai");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("0");
  const [enabled, setEnabled] = useState(true);
  const [headers, setHeaders] = useState("");
  const [faces, setFaces] = useState<ProviderFacesValue>({
    openaiEnabled: true,
    upstreamFormat: "responses",
    anthropicEnabled: false,
    anthropicBaseUrl: "",
  });
  const [modelRows, setModelRows] = useState<ProviderModelRow[]>([]);

  // Fetch-models state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchResult, setFetchResult] = useState<{ count: number; status: number; latencyMs: number; error?: string } | null>(null);

  // Submit state
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Context/output defaults for rows added by hand follow the selected template.
  const activeTemplateModelDefaults = (() => {
    const tpl = PROVIDER_TEMPLATES.find((t) => t.id === templateId);
    return {
      contextLength: tpl?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH,
      maxOutputTokens: tpl?.defaultMaxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  })();

  function applyTemplate(id: string) {
    const tpl = PROVIDER_TEMPLATES.find((tpl) => tpl.id === id);
    if (!tpl) return;
    setTemplateId(id);
    setKind(tpl.kind === "azure" ? "custom-openai" : (tpl.kind as Kind));
    if (tpl.defaultBaseUrl) setBaseUrl(tpl.defaultBaseUrl);
    
    setModelRows(
      Object.entries(tpl.defaultModelMapping).map(([clientId, upstreamId]) =>
        newModelRow({
          clientId,
          upstreamId,
          contextLength: tpl.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH,
          maxOutputTokens: tpl.defaultMaxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
        }),
      ),
    );
    
    setName(tpl.label);
    if (tpl.defaultHeaders) {
      setHeaders(Object.entries(tpl.defaultHeaders).map(([k, v]) => `${k}: ${v}`).join("\n"));
    }
    // Always reset this: otherwise switching from the Anthropic template back
    // to an OpenAI-compatible one would leave the Anthropic face on. The
    // template's `anthropic` format means "Anthropic face only".
    const templateFormat = tpl.defaultUpstreamFormat ?? "responses";
    setFaces({
      openaiEnabled: templateFormat !== "anthropic",
      upstreamFormat: templateFormat === "anthropic" ? "responses" : templateFormat,
      anthropicEnabled: templateFormat === "anthropic",
      anthropicBaseUrl: "",
    });
    setFetchResult(null);
  }

  function reset() {
    setName(""); setBaseUrl(""); setApiKey("");
    setPriority("0"); setEnabled(true); setHeaders("");
    setModelRows([]); setError(null); setFetchResult(null);
    setFaces({
      openaiEnabled: true,
      upstreamFormat: "responses",
      anthropicEnabled: false,
      anthropicBaseUrl: "",
    });
    setTemplateId("openai");
  }

  async function fetchModels() {
    if (!baseUrl || !apiKey) return;
    
    setFetchingModels(true);
    setFetchResult(null);
    try {
      const res = await fetch(`/api/admin/providers/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, kind, path: PROVIDER_TEMPLATES.find(t => t.id === templateId)?.modelsListPath }),
      });
      
      // Handle empty or non-JSON responses
      const text = await res.text();
      if (!text) {
        setFetchResult({
          count: 0,
          status: res.status,
          latencyMs: 0,
          error: t("common.networkError") + " (empty response)",
        });
        setFetchingModels(false);
        return;
      }
      
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setFetchResult({
          count: 0,
          status: res.status,
          latencyMs: 0,
          error: t("common.networkError") + " (invalid JSON: " + text.slice(0, 100) + ")",
        });
        setFetchingModels(false);
        return;
      }
      if (data.ok) {
        const ids: string[] = data.models ?? [];
        setFetchResult({ count: ids.length, status: data.status, latencyMs: data.latencyMs });
        
        // Add new models that aren't already in the list
        const currentTemplate = PROVIDER_TEMPLATES.find(t => t.id === templateId);
        setModelRows((prev) =>
          mergeFetchedModels(prev, ids, {
            contextLength: currentTemplate?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH,
            maxOutputTokens: currentTemplate?.defaultMaxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
          }),
        );
      } else {
        setFetchResult({
          count: 0,
          status: data.status ?? 0,
          latencyMs: data.latencyMs ?? 0,
          error: data.error ?? t("common.failed"),
        });
      }
    } catch (err) {
      setFetchResult({
        count: 0,
        status: 0,
        latencyMs: 0,
        error: err instanceof Error ? err.message : t("common.networkError"),
      });
    } finally {
      setFetchingModels(false);
    }
  }

  function parseHeaders(): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of headers.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k && v) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { modelMapping, modelConfigs } = rowsToPayload(modelRows);

      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || templateId,
          kind,
          baseUrl: baseUrl || null,
          apiKey,
          modelMapping,
          modelConfigs,
          enabled,
          priority: Number(priority) || 0,
          headers: parseHeaders(),
          openaiEnabled: faces.openaiEnabled,
          upstreamFormat: faces.upstreamFormat === "anthropic" ? "responses" : faces.upstreamFormat,
          anthropicEnabled: faces.anthropicEnabled,
          anthropicBaseUrl: faces.anthropicBaseUrl || null,
        }),
      });
      
      // Handle empty or non-JSON responses
      const text = await res.text();
      if (!text) {
        setError(t("common.networkError") + " (empty response)");
        setLoading(false);
        return;
      }
      
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setError(t("common.networkError") + " (invalid server response)");
        setLoading(false);
        return;
      }

      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        return;
      }

      reset();
      setOpen(false);
      onCreated?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => { reset(); setOpen(true); }}>
        {t("admin.providers.create")}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("admin.providers.create")} extraWide>
        <form onSubmit={onSubmit} className="space-y-4">
          {/* Template selection */}
          <div>
            <label className="block text-sm font-medium mb-1.5">{t("admin.providers.create.template")}</label>
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {PROVIDER_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {PROVIDER_TEMPLATES.find((t) => t.id === templateId)?.description}
            </p>
          </div>

          {/* Name */}
          <Input
            label={t("admin.providers.create.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("admin.providers.create.namePlaceholder")}
          />

          {/* Base URL */}
          <Input
            label={t("admin.providers.create.baseUrl")}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            required
          />

          {/* API Key */}
          <Input
            label={t("admin.providers.create.apiKey")}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            required
          />

          {/* Priority */}
          <Input
            label={t("admin.providers.create.priority")}
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />

          {/* Headers */}
          <div>
            <label className="block text-sm font-medium mb-1.5">{t("admin.providers.create.headers")}</label>
            <textarea
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              placeholder="api-version: 2024-08-01-preview"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t("admin.providers.create.headersHint")}</p>
          </div>

          {/* Protocol faces */}
          <ProviderFacesField value={faces} onChange={setFaces} />

          {/* Model mapping with config */}
          <ProviderModelsEditor
            rows={modelRows}
            onChange={setModelRows}
            newRowDefaults={activeTemplateModelDefaults}
            actions={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={fetchModels}
                loading={fetchingModels}
                disabled={!baseUrl || !apiKey}
              >
                ↻ {t("admin.providers.create.autoFetch")}
              </Button>
            }
            hint={
              <>
                {t("admin.providers.models.costHint")}
                {fetchingModels && <span className="ml-2">{t("admin.providers.create.fetching")}</span>}
                {fetchResult && (
                  <span className={fetchResult.error ? "ml-2 text-destructive" : "ml-2 text-success"}>
                    {fetchResult.error
                      ? `✗ ${fetchResult.error}`
                      : `✓ ${fetchResult.count} models fetched (${fetchResult.latencyMs}ms)`}
                  </span>
                )}
              </>
            }
          />

          {/* Enabled */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded"
            />
            {t("admin.providers.create.enabled")}
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={loading || isPending}>
              {t("admin.providers.create.submit")}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
