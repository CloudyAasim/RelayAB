"use client";

/**
 * src/app/(admin)/admin/providers/ProviderActions.tsx
 *
 * Inline per-row actions for the providers list:
 *   - Test connection (live HTTP probe, shows latency + status)
 *   - Edit provider (opens edit modal)
 *   - Fetch models (updates model mapping via PATCH)
 *   - Delete (with confirm)
 *
 * After any mutation, we reload the page to reflect the new state.
 */
import { useState } from "react";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { useT } from "@/components/i18n/I18nProvider";

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
  enabled: boolean;
  priority: number;
}

type TestResult =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "ok";    status: number; latencyMs: number }
  | { phase: "fail";  status: number; latencyMs: number; error: string };

export function ProviderActions({ providerId, providerName }: Props) {
  const t = useT();
  const [isPending, startTransition] = useTransition();
  const [test, setTest] = useState<TestResult>({ phase: "idle" });
  const [busy, setBusy] = useState<"" | "test" | "fetch" | "delete">("");
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
    // Fetch current provider data
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
        <Button size="sm" variant="ghost" onClick={runTest} loading={busy === "test"}>
          {t("admin.providers.test")}
        </Button>
        <Button size="sm" variant="ghost" onClick={openEdit}>
          ✎
        </Button>
        <Button size="sm" variant="ghost" onClick={fetchModels} loading={busy === "fetch"}>
          ↻
        </Button>
        <Button size="sm" variant="ghost" onClick={remove} loading={busy === "delete"}>
          {t("common.delete")}
        </Button>
      </div>
      {test.phase === "ok" && (
        <span className="text-[10px] font-mono text-emerald-600">
          ✓ HTTP {test.status}, {test.latencyMs}ms
        </span>
      )}
      {test.phase === "fail" && (
        <span className="text-[10px] font-mono text-red-600">
          ✗ {test.error}
        </span>
      )}
      {test.phase === "testing" && (
        <span className="text-[10px] font-mono text-slate-500">…</span>
      )}

      {provider && (
        <EditProviderModalWrapper
          open={editOpen}
          onClose={() => setEditOpen(false)}
          provider={provider}
        />
      )}
    </>
  );
}

function EditProviderModalWrapper({ open, onClose, provider }: {
  open: boolean;
  onClose: () => void;
  provider: Provider;
}) {
  const t = useT();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider.enabled);
  const [priority, setPriority] = useState(String(provider.priority));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name,
        enabled,
        priority: Number(priority) || 0,
      };
      if (baseUrl !== provider.baseUrl) {
        body.baseUrl = baseUrl || null;
      }
      if (apiKey) {
        body.apiKey = apiKey;
      }

      const res = await fetch(`/api/admin/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        return;
      }

      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("admin.providers.edit")}>
      <form onSubmit={handleSubmit} className="space-y-4">
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

        <Input
          label={t("admin.providers.create.apiKey") + " (" + t("admin.providers.edit.leaveBlank") + ")"}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="••••••••"
        />

        <Input
          label={t("admin.providers.create.priority")}
          type="number"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />

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
