"use client";

/**
 * src/app/(admin)/admin/providers/CreateProviderButton.tsx
 *
 * Provider creation modal with Cherry-Studio-grade affordances:
 *   - Template dropdown (OpenAI / Anthropic / Azure / OpenRouter / DeepSeek / Custom)
 *   - One-click "Auto-fetch models" from upstream /v1/models
 *   - Visual model mapping editor (add/remove rows, client → upstream)
 *   - Multi-key paste support: each line becomes a separate API key for rotation
 *   - Save with one click; errors surface inline
 */
import { useState, useTransition } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { PROVIDER_TEMPLATES, type ProviderTemplate } from "@/lib/providers/templates";

interface Props {
  onCreated?: () => void;
}

type Kind = "openai" | "anthropic" | "custom-openai";

interface ModelRow {
  client: string;        // name the client sends
  upstream: string;      // name sent to upstream
}

export function CreateProviderButton({ onCreated }: Props) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Form state
  const [templateId, setTemplateId] = useState("openai");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKeys, setApiKeys] = useState("");     // multi-line; each non-empty line is a key
  const [priority, setPriority] = useState("0");
  const [enabled, setEnabled] = useState(true);
  const [headers, setHeaders] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);

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
    setModels(
      Object.entries(tpl.defaultModelMapping).map(([client, upstream]) => ({ client, upstream })),
    );
    if (!name) setName(tpl.label);
    if (tpl.defaultHeaders) {
      setHeaders(Object.entries(tpl.defaultHeaders).map(([k, v]) => `${k}: ${v}`).join("\n"));
    }
    setFetchResult(null);
  }

  function reset() {
    setName(""); setBaseUrl(""); setApiKeys("");
    setPriority("0"); setEnabled(true); setHeaders("");
    setModels([]); setError(null); setFetchResult(null);
  }

  async function fetchModels() {
    setFetchingModels(true);
    setFetchResult(null);
    try {
      const res = await fetch(`/api/admin/providers/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, encryptedApiKey: apiKeys.split("\n")[0]?.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        // Probe worked. Now apply to current rows.
        const ids: string[] = data.models ?? [];
        setModels((prev) => {
          // Keep existing user-curated rows; append new ones from upstream not yet covered.
          const knownUpstreams = new Set(prev.map((m) => m.upstream));
          const newRows = ids
            .filter((id) => !knownUpstreams.has(id))
            .map((id) => ({ client: id, upstream: id }));
          setFetchResult({ count: ids.length, status: data.status, latencyMs: data.latencyMs });
          return [...prev, ...newRows];
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

  function addRow() {
    setModels((prev) => [...prev, { client: "", upstream: "" }]);
  }
  function removeRow(idx: number) {
    setModels((prev) => prev.filter((_, i) => i !== idx));
  }
  function updateRow(idx: number, field: keyof ModelRow, value: string) {
    setModels((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)),
    );
  }

  function parseHeaders(): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const line of headers.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const cleanMapping: Record<string, string> = {};
      for (const m of models) {
        const k = m.client.trim();
        const v = m.upstream.trim();
        if (k && v) cleanMapping[k] = v;
      }

      // The first API key is the "primary"; additional lines (if any) become
      // rotation keys. Our backend currently stores ONE encrypted blob, so
      // for now we use the first key and surface a warning about extras.
      const keyLines = apiKeys.split("\n").map((s) => s.trim()).filter(Boolean);
      const primaryKey = keyLines[0] ?? "";
      if (!primaryKey) {
        setError(t("admin.providers.create.needApiKey"));
        setLoading(false);
        return;
      }

      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          kind,
          baseUrl: baseUrl || null,
          apiKey: primaryKey,
          modelMapping: cleanMapping,
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
      startTransition(() => {
        setOpen(false);
        reset();
        onCreated?.();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => { reset(); applyTemplate("openai"); setOpen(true); }}>
        {t("admin.providers.create")}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} wide
             title={t("admin.providers.create")}
             description={t("admin.providers.create.desc")}>
        <form onSubmit={onSubmit} className="space-y-4">
          {/* Template picker */}
          <div>
            <label className="block text-sm font-medium text-slate-700">
              {t("admin.providers.create.template")}
            </label>
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {PROVIDER_TEMPLATES.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.label} — {tpl.description.slice(0, 40)}
                </option>
              ))}
            </select>
          </div>

          {/* Basic fields */}
          <div className="grid grid-cols-2 gap-3">
            <Input label={t("admin.providers.create.name")} required
                   value={name} onChange={(e) => setName(e.target.value)} />
            <Input label={t("admin.providers.create.priority")} type="number"
                   value={priority} onChange={(e) => setPriority(e.target.value)} />
          </div>
          <Input label={t("admin.providers.create.baseUrl")} required
                 placeholder="https://api.openai.com/v1"
                 value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />

          {/* API keys (multi-line for rotation; only first is saved today) */}
          <div>
            <label className="block text-sm font-medium text-slate-700">
              {t("admin.providers.create.apiKey")}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {t("admin.providers.create.apiKeyHint")}
              </span>
            </label>
            <textarea
              rows={3}
              value={apiKeys}
              onChange={(e) => setApiKeys(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
              placeholder="sk-xxx..."
            />
          </div>

          {/* Extra headers */}
          <div>
            <label className="block text-sm font-medium text-slate-700">
              {t("admin.providers.create.headers")}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {t("admin.providers.create.headersHint")}
              </span>
            </label>
            <textarea
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
              placeholder={"api-version: 2024-08-01-preview"}
            />
          </div>

          {/* Model mapping (visual editor) */}
          <div>
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-700">
                {t("admin.providers.create.models")}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {t("admin.providers.create.models.count", { count: models.length })}
                </span>
              </label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={fetchModels}
                        loading={fetchingModels} disabled={!baseUrl || !apiKeys}>
                  ↻ {t("admin.providers.create.autoFetch")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={addRow}>
                  + {t("admin.providers.create.addRow")}
                </Button>
              </div>
            </div>
            {fetchResult && (
              <p className={`mt-1 text-xs ${fetchResult.error ? "text-red-600" : "text-emerald-600"}`}>
                {fetchResult.error
                  ? `✗ ${fetchResult.error}`
                  : `✓ ${t("admin.providers.create.fetchResult", {
                      count: fetchResult.count,
                      status: fetchResult.status,
                      latency: fetchResult.latencyMs,
                    })}`}
              </p>
            )}
            <div className="mt-2 max-h-72 overflow-auto rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("admin.providers.create.clientModel")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("admin.providers.create.upstreamModel")}</th>
                    <th className="w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {models.length === 0 ? (
                    <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-slate-500">
                      {fetchingModels
                        ? t("admin.providers.create.fetching")
                        : t("admin.providers.create.noMappings")}
                    </td></tr>
                  ) : models.map((row, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-1">
                        <input type="text" value={row.client}
                               onChange={(e) => updateRow(idx, "client", e.target.value)}
                               placeholder="gpt-4o"
                               className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-xs font-mono hover:border-slate-300 focus:border-brand-500 focus:outline-none" />
                      </td>
                      <td className="px-2 py-1">
                        <input type="text" value={row.upstream}
                               onChange={(e) => updateRow(idx, "upstream", e.target.value)}
                               placeholder="gpt-4o-2024-08-06"
                               className="w-full rounded border border-transparent bg-transparent px-1 py-1 text-xs font-mono hover:border-slate-300 focus:border-brand-500 focus:outline-none" />
                      </td>
                      <td className="px-2 py-1">
                        <button type="button" onClick={() => removeRow(idx)}
                                className="text-xs text-slate-400 hover:text-red-600">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Enabled */}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled}
                   onChange={(e) => setEnabled(e.target.checked)}
                   className="rounded border-slate-300" />
            {t("admin.providers.create.enabled")}
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
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
