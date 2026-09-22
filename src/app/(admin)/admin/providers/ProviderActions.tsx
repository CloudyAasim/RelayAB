"use client";

import { useState, useEffect } from "react";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";
import { RefreshCw, Pencil, Trash2, Zap, X } from "lucide-react";

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
  const [error, setError] = useState("");

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(String(provider.priority ?? "1"));
  const [enabled, setEnabled] = useState(provider.enabled);
  const [modelMapping, setModelMapping] = useState<Record<string, string>>(provider.modelMapping ?? {});

  // Sync state when provider changes
  useEffect(() => {
    if (open && provider) {
      setName(provider.name);
      setBaseUrl(provider.baseUrl ?? "");
      setApiKey("");
      setPriority(String(provider.priority ?? "1"));
      setEnabled(provider.enabled);
      setModelMapping(provider.modelMapping ?? {});
    }
  }, [open, provider]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/admin/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          baseUrl: baseUrl || null,
          apiKey: apiKey || undefined,
          priority: Number(priority),
          enabled,
          modelMapping,
        }),
      });
      const data = await res.json();
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

          <Input
            label={t("admin.providers.create.baseUrl")}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>

        <Input
          label={t("admin.providers.create.apiKey") + " (" + t("admin.providers.edit.leaveBlank") + ")"}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="••••••••"
        />

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

        <div>
          <label className="block text-sm font-medium mb-2">{t("admin.providers.table.models")}</label>
          <div className="max-h-60 overflow-y-auto border rounded-md">
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-xs">{t("admin.providers.model.clientId")}</th>
                  <th className="px-2 py-1 text-left font-medium text-xs">{t("admin.providers.model.upstreamId")}</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {Object.entries(modelMapping).map(([client, upstream]) => (
                  <tr key={client}>
                    <td className="px-1 py-0.5">
                      <input
                        type="text"
                        value={client}
                        onChange={(e) => {
                          const oldUpstream = modelMapping[client];
                          const newMapping = { ...modelMapping };
                          delete newMapping[client];
                          newMapping[e.target.value] = oldUpstream;
                          setModelMapping(newMapping);
                        }}
                        className="w-full rounded border bg-transparent px-1 py-0.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-1 py-0.5">
                      <input
                        type="text"
                        value={upstream}
                        onChange={(e) => setModelMapping(prev => ({ ...prev, [client]: e.target.value }))}
                        className="w-full rounded border bg-transparent px-1 py-0.5 font-mono text-xs"
                      />
                    </td>
                    <td className="px-1 py-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          const newMapping = { ...modelMapping };
                          delete newMapping[client];
                          setModelMapping(newMapping);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setModelMapping(prev => ({ ...prev, [crypto.randomUUID()]: "" }))}
            className="mt-2 text-sm text-primary hover:underline"
          >
            + {t("admin.providers.model.add")}
          </button>
        </div>

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
