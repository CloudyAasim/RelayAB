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
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "@/lib/providers/templates";

interface Props {
  onCreated?: () => void;
}

type Kind = "openai" | "anthropic" | "custom-openai";

interface ModelConfig {
  client: string;
  upstream: string;
  contextLength: number;
  maxOutputTokens: number;
  inputCost: number;
  outputCost: number;
}

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
  const [models, setModels] = useState<ModelConfig[]>([]);

  // Fetch-models state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchResult, setFetchResult] = useState<{ count: number; status: number; latencyMs: number; error?: string } | null>(null);

  // Submit state
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function applyTemplate(id: string) {
    const tpl = PROVIDER_TEMPLATES.find((tpl) => tpl.id === id);
    if (!tpl) return;
    setTemplateId(id);
    setKind(tpl.kind === "azure" ? "custom-openai" : (tpl.kind as Kind));
    if (tpl.defaultBaseUrl) setBaseUrl(tpl.defaultBaseUrl);
    
    // Convert template model mapping to full ModelConfig
    const templateModels: ModelConfig[] = Object.entries(tpl.defaultModelMapping).map(
      ([client, upstream]) => ({
        client,
        upstream,
        contextLength: tpl.defaultContextLength ?? 128000,
        maxOutputTokens: tpl.defaultMaxOutput ?? 8192,
        inputCost: 0,
        outputCost: 0,
      })
    );
    setModels(templateModels);
    
    setName(tpl.label);
    if (tpl.defaultHeaders) {
      setHeaders(Object.entries(tpl.defaultHeaders).map(([k, v]) => `${k}: ${v}`).join("\n"));
    }
    setFetchResult(null);
  }

  function reset() {
    setName(""); setBaseUrl(""); setApiKey("");
    setPriority("0"); setEnabled(true); setHeaders("");
    setModels([]); setError(null); setFetchResult(null);
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
      const data = await res.json();
      if (data.ok) {
        const ids: string[] = data.models ?? [];
        setFetchResult({ count: ids.length, status: data.status, latencyMs: data.latencyMs });
        
        // Add new models that aren't already in the list
        const currentTemplate = PROVIDER_TEMPLATES.find(t => t.id === templateId);
        const defaultCtx = currentTemplate?.defaultContextLength ?? 128000;
        const defaultOut = currentTemplate?.defaultMaxOutput ?? 8192;
        setModels((prev) => {
          const knownClients = new Set(prev.map((m) => m.client));
          const newModels: ModelConfig[] = ids
            .filter((id) => !knownClients.has(id))
            .map((id) => ({
              client: id,
              upstream: id,
              contextLength: defaultCtx,
              maxOutputTokens: defaultOut,
              inputCost: 0,
              outputCost: 0,
            }));
          return [...prev, ...newModels];
        });
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

  function addModel() {
    const tpl = PROVIDER_TEMPLATES.find(t => t.id === templateId);
    const defaultCtx = tpl?.defaultContextLength ?? 128000;
    const defaultOut = tpl?.defaultMaxOutput ?? 8192;
    setModels((prev) => [
      ...prev,
      { client: "", upstream: "", contextLength: defaultCtx, maxOutputTokens: defaultOut, inputCost: 0, outputCost: 0 },
    ]);
  }

  function removeModel(idx: number) {
    setModels((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateModel(idx: number, field: keyof ModelConfig, value: string | number) {
    setModels((prev) =>
      prev.map((m, i) =>
        i === idx ? { ...m, [field]: value } : m
      )
    );
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
      // Build modelMapping and modelConfigs
      const modelMapping: Record<string, string> = {};
      const modelConfigs: Record<string, any> = {};
      
      for (const m of models) {
        if (m.client && m.upstream) {
          modelMapping[m.client] = m.upstream;
          modelConfigs[m.client] = {
            upstreamId: m.upstream,
            clientId: m.client,
            contextLength: m.contextLength,
            maxOutputTokens: m.maxOutputTokens,
            inputCost: m.inputCost,
            outputCost: m.outputCost,
            enabled: true,
          };
        }
      }

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
        }),
      });
      const data = await res.json();

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

          {/* Model mapping with config */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">{t("admin.providers.create.models")}</label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={fetchModels} loading={fetchingModels} disabled={!baseUrl || !apiKey}>
                  ↻ {t("admin.providers.create.autoFetch")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={addModel}>
                  + {t("admin.providers.create.addRow")}
                </Button>
              </div>
            </div>
            
            {fetchResult && (
              <p className={`mb-2 text-xs ${fetchResult.error ? "text-destructive" : "text-success"}`}>
                {fetchResult.error
                  ? `✗ ${fetchResult.error}`
                  : `✓ ${fetchResult.count} models fetched (${fetchResult.latencyMs}ms)`}
              </p>
            )}

            {/* Model list */}
            <div className="max-h-72 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">{t("admin.providers.create.clientModel")}</th>
                    <th className="px-2 py-1.5 text-left font-medium">上游模型</th>
                    <th className="px-2 py-1.5 text-left font-medium">上下文</th>
                    <th className="px-2 py-1.5 text-left font-medium">输出</th>
                    <th className="px-2 py-1.5 text-left font-medium">输入积分</th>
                    <th className="px-2 py-1.5 text-left font-medium">输出积分</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {models.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                        {fetchingModels ? t("admin.providers.create.fetching") : t("admin.providers.create.noMappings")}
                      </td>
                    </tr>
                  ) : (
                    models.map((m, idx) => (
                      <tr key={idx}>
                        <td className="px-1 py-1">
                          <input
                            type="text"
                            value={m.client}
                            onChange={(e) => updateModel(idx, "client", e.target.value)}
                            placeholder="gpt-4o"
                            className="w-full rounded border bg-transparent px-1 py-0.5 font-mono"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="text"
                            value={m.upstream}
                            onChange={(e) => updateModel(idx, "upstream", e.target.value)}
                            placeholder="gpt-4o-2024-08-06"
                            className="w-full rounded border bg-transparent px-1 py-0.5 font-mono"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            value={m.contextLength}
                            onChange={(e) => updateModel(idx, "contextLength", Number(e.target.value))}
                            className="w-20 rounded border bg-transparent px-1 py-0.5"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            value={m.maxOutputTokens}
                            onChange={(e) => updateModel(idx, "maxOutputTokens", Number(e.target.value))}
                            className="w-20 rounded border bg-transparent px-1 py-0.5"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            value={m.inputCost}
                            onChange={(e) => updateModel(idx, "inputCost", Number(e.target.value))}
                            step="0.1"
                            className="w-16 rounded border bg-transparent px-1 py-0.5"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <input
                            type="number"
                            value={m.outputCost}
                            onChange={(e) => updateModel(idx, "outputCost", Number(e.target.value))}
                            step="0.1"
                            className="w-16 rounded border bg-transparent px-1 py-0.5"
                          />
                        </td>
                        <td className="px-1 py-1">
                          <button type="button" onClick={() => removeModel(idx)} className="text-muted-foreground hover:text-destructive">
                            ×
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              积分: 每百万Token消耗的积分数量 (0 = 免费)
            </p>
          </div>

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
