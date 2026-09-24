"use client";

import { useState, useEffect } from "react";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { RefreshCw, Pencil, Trash2, Zap } from "lucide-react";
import {
  ProviderFacesField,
  type ProviderFacesValue,
  type UpstreamFormat,
} from "./ProviderFacesField";
import {
  mergeFetchedModels,
  rowsFromProvider,
  rowsToPayload,
  type ProviderModelRow,
} from "./model-rows";
import { ProviderModelsEditor } from "./ProviderModelsEditor";

interface Props {
  providerId: string;
  providerName: string;
}

interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  modelMapping: Record<string, string>;
  modelConfigs: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  upstreamFormat?: UpstreamFormat;
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicBaseUrl?: string | null;
}

/**
 * Edit-form state for the two protocol faces.
 *
 * Legacy rows (`upstreamFormat: "anthropic"`, or `kind: "anthropic"`) read back
 * as "Anthropic only"; saving rewrites them into the two-flag shape.
 */
function facesFromProvider(provider: Provider): ProviderFacesValue {
  const format = provider.upstreamFormat ?? "responses";
  const anthropicOnly = format === "anthropic";
  return {
    openaiEnabled: provider.openaiEnabled ?? !anthropicOnly,
    upstreamFormat: anthropicOnly ? "responses" : format,
    anthropicEnabled: provider.anthropicEnabled ?? anthropicOnly,
    anthropicBaseUrl: provider.anthropicBaseUrl ?? "",
  };
}

type TestResult =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok"; status: number; latencyMs: number }
  | { phase: "fail"; status: number; latencyMs: number; error: string };

export function ProviderActions({ providerId, providerName }: Props) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [test, setTest] = useState<TestResult>({ phase: "idle" });
  const [busy, setBusy] = useState<"" | "test" | "fetch" | "delete" | "save">("");
  const [editOpen, setEditOpen] = useState(false);
  const [provider, setProvider] = useState<Provider | null>(null);

  async function runTest() {
    setBusy("test");
    setTest({ phase: "testing" });
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/test`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setTest({ phase: "ok", status: data.status, latencyMs: data.latencyMs });
      } else {
        setTest({ phase: "fail", status: data.status ?? 0, latencyMs: data.latencyMs ?? 0, error: data.error ?? t("common.failed") });
      }
    } catch (err) {
      setTest({ phase: "fail", status: 0, latencyMs: 0, error: err instanceof Error ? err.message : t("common.networkError") });
    } finally {
      setBusy("");
    }
  }

  async function openEdit() {
    const res = await fetch("/api/admin/providers");
    const data = await res.json();
    if (!data.ok) return;
    const p = data.data?.providers?.find((x: Provider) => x.id === providerId);
    if (p) {
      setProvider(p);
      setEditOpen(true);
    }
  }

  async function fetchModels() {
    setBusy("fetch");
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/models`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        alert(t("admin.providers.fetchFailed", { error: data.error ?? t("common.unknown") }));
        return;
      }
      const currentMapping = await fetchCurrentModelMapping(providerId);
      const ids: string[] = data.models ?? [];
      const merged = { ...currentMapping };
      for (const id of ids) {
        if (!(id in merged)) merged[id] = id;
      }
      const patch = await fetch(`/api/admin/providers/${providerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelMapping: merged }),
      });
      const patchData = await patch.json();
      if (!patchData.ok) {
        alert(t("admin.providers.saveFailed", { error: patchData.error?.message ?? t("common.unknown") }));
        return;
      }
      startTransition(() => window.location.reload());
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    if (!confirm(t("admin.providers.confirmDelete", { name: providerName }))) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/admin/providers/${providerId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) {
        alert(t("admin.providers.deleteFailed", { error: data.error?.message ?? t("common.unknown") }));
        return;
      }
      startTransition(() => window.location.reload());
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <div className="flex flex-row items-center gap-1">
        <Button size="icon" variant="ghost" onClick={runTest} loading={busy === "test"} title={t("admin.providers.test")}>
          <Zap className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={openEdit} title={t("common.edit")}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={fetchModels} loading={busy === "fetch"} title={t("admin.providers.fetchModels")}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={remove} loading={busy === "delete"} title={t("common.delete")}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {test.phase === "ok" && (
        <span className="ml-2 text-xs font-mono text-emerald-600 whitespace-nowrap">
          ✓ {test.latencyMs}ms
        </span>
      )}
      {test.phase === "fail" && (
        <span className="ml-2 text-xs font-mono text-red-600 whitespace-nowrap">
          ✗ {test.error}
        </span>
      )}
      {test.phase === "testing" && (
        <span className="ml-2 text-xs font-mono text-slate-500">…</span>
      )}

      {provider && (
        <EditProviderModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          provider={provider}
          onSaved={() => {
            setEditOpen(false);
            startTransition(() => window.location.reload());
          }}
        />
      )}
    </>
  );
}

interface EditModalProps {
  open: boolean;
  onClose: () => void;
  provider: Provider;
  onSaved: () => void;
}

function EditProviderModal({ open, onClose, provider, onSaved }: EditModalProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState(provider.name);
  const [kind, setKind] = useState(provider.kind);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(String(provider.priority ?? "1"));
  const [enabled, setEnabled] = useState(provider.enabled);
  const [faces, setFaces] = useState<ProviderFacesValue>(() => facesFromProvider(provider));
  const [modelRows, setModelRows] = useState<ProviderModelRow[]>(() =>
    rowsFromProvider(provider.modelMapping, provider.modelConfigs),
  );

  // Sync state when provider changes
  useEffect(() => {
    if (open && provider) {
      setName(provider.name);
      setKind(provider.kind);
      setBaseUrl(provider.baseUrl ?? "");
      setApiKey("");
      setPriority(String(provider.priority ?? "1"));
      setEnabled(provider.enabled);
      setFaces(facesFromProvider(provider));
      setModelRows(rowsFromProvider(provider.modelMapping, provider.modelConfigs));
      setError("");
    }
  }, [open, provider]);

  /**
   * Pull the upstream model list and merge it into the mapping being edited.
   *
   * Uses the *stored* provider credentials, so it picks up whatever was saved
   * last — the hint under the button says so. The merge is additive: existing
   * aliases are never overwritten.
   */
  async function syncModels() {
    setSyncing(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/providers/${provider.id}/models`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(t("admin.providers.fetchFailed", { error: data.error ?? t("common.unknown") }));
        return;
      }
      const ids: string[] = data.models ?? [];
      setModelRows((prev) => mergeFetchedModels(prev, ids));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.networkError"));
    } finally {
      setSyncing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    // Debug: log what we're about to send
    console.log("[EditProviderModal] Submitting with enabled:", enabled, "type:", typeof enabled);

    try {
      const res = await fetch(`/api/admin/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          kind,
          baseUrl: baseUrl || null,
          apiKey: apiKey || undefined,
          priority: Number(priority),
          enabled,
          openaiEnabled: faces.openaiEnabled,
          upstreamFormat: faces.upstreamFormat === "anthropic" ? "responses" : faces.upstreamFormat,
          anthropicEnabled: faces.anthropicEnabled,
          anthropicBaseUrl: faces.anthropicBaseUrl || null,
          ...rowsToPayload(modelRows),
        }),
      });
      const data = await res.json();
      console.log("[EditProviderModal] PATCH response:", JSON.stringify(data));
      if (!data.ok) {
        setError(data.error?.message ?? t("common.saveFailed"));
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.saveFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.providers.edit")} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t("admin.providers.create.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              {t("admin.providers.table.kind")}
            </label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
              <option value="custom-openai">custom-openai</option>
              <option value="azure">azure</option>
            </select>
          </div>
        </div>

        <Input
          label={t("admin.providers.create.baseUrl")}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <Input
          label={t("admin.providers.create.apiKey") + " (" + t("admin.providers.edit.leaveBlank") + ")"}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="••••••••"
        />

        <ProviderFacesField value={faces} onChange={setFaces} />

        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t("admin.providers.create.priority")}
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />

          <label className="flex items-center gap-2 pt-6">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded w-4 h-4"
            />
            {t("dashboard.status.enabled")}
          </label>
        </div>

        <ProviderModelsEditor
          rows={modelRows}
          onChange={setModelRows}
          hint={t("admin.providers.syncHint")}
          actions={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={syncModels}
              loading={syncing}
              title={t("admin.providers.syncHint")}
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("admin.providers.fetchModels")}
            </Button>
          }
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={loading}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

async function fetchCurrentModelMapping(providerId: string): Promise<Record<string, string>> {
  const res = await fetch("/api/admin/providers");
  const data = await res.json();
  if (!data.ok) return {};
  const me = data.data?.providers?.find((p: { id: string }) => p.id === providerId);
  return (me?.modelMapping ?? {}) as Record<string, string>;
}
