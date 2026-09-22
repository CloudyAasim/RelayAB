"use client";

/**
 * src/app/(admin)/admin/providers/ProviderActions.tsx
 *
 * Inline per-row actions for the providers list:
 *   - Test connection (live HTTP probe, shows latency + status)
 *   - Fetch models (updates model mapping via PUT)
 *   - Delete (with confirm)
 *
 * After any mutation, we reload the page to reflect the new state.
 */
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";

interface Props {
  providerId: string;
  providerName: string;
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

  async function fetchModels() {
    setBusy("fetch");
    try {
      const res = await fetch(`/api/admin/providers/${providerId}/models`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        alert(t("admin.providers.fetchFailed", { error: data.error ?? t("common.unknown") }));
        return;
      }
      // Merge fetched model IDs into current modelMapping (client = upstream = id).
      // We do this client-side and PATCH the provider.
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
    <div className="flex flex-row items-center gap-2 flex-wrap">
      <Button size="sm" variant="ghost" onClick={runTest} loading={busy === "test"}>
        {t("admin.providers.test")}
      </Button>
      <Button size="sm" variant="ghost" onClick={fetchModels} loading={busy === "fetch"}>
        ↻
      </Button>
      <Button size="sm" variant="ghost" onClick={remove} loading={busy === "delete"}>
        {t("common.delete")}
      </Button>
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
    </div>
  );
}

async function fetchCurrentModelMapping(providerId: string): Promise<Record<string, string>> {
  const res = await fetch("/api/admin/providers");
  const data = await res.json();
  if (!data.ok) return {};
  const me = data.data?.providers?.find((p: { id: string }) => p.id === providerId);
  return (me?.modelMapping ?? {}) as Record<string, string>;
}
