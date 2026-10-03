"use client";

import { useState, useEffect } from "react";
import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { useT } from "@/components/i18n/I18nProvider";
import { RefreshCw, Pencil, Trash2, Zap } from "lucide-react";
import type { UpstreamFormat } from "./ProviderInterfacesField";
import { mergeFetchedModels } from "./model-rows";
import { ProviderForm } from "./form/ProviderForm";
import { formValuesFromProvider, useProviderForm } from "./form/use-provider-form";

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
  /** Read back into the headers box; editable here now that both forms carry it. */
  headers?: Record<string, string> | null;
  upstreamFormat?: UpstreamFormat;
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicBaseUrl?: string | null;
  /** One protocol document per compatibility interface. Decides which mode opens. */
  textSpecs?: string[];
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

/**
 * Editing a provider.
 *
 * All the state, the field layout and the request body come from
 * `useProviderForm` / `ProviderForm`, the same ones the create modal uses. What
 * is left here is the three things that are genuinely about *editing*: which
 * URL to PATCH, that the key is optional here, and that an empty protocol list
 * has to be sent (not omitted) so a saved list can be cleared.
 */
function EditProviderModal({ open, onClose, provider, onSaved }: EditModalProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const form = useProviderForm(() => formValuesFromProvider(provider));
  const { load, specVerdict, setMode, buildPayload, values } = form;

  // Re-read when the row changes under us. `load` is stable, so this does not
  // fire on every render of the page behind the modal.
  useEffect(() => {
    if (open) load(provider);
  }, [open, provider, load]);

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
      const res = await fetch(`/api/admin/providers/${provider.id}/models`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setError(t("admin.providers.fetchFailed", { error: data.error ?? t("common.unknown") }));
        return;
      }
      form.setModelRows((prev) => mergeFetchedModels(prev, data.models ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.networkError"));
    } finally {
      setSyncing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The fields are sent whichever mode is open: a protocol governs the
    // parameters on the way, it does not decide which endpoint is called.
    if (!specVerdict.ok) {
      setError(specVerdict.errors[0]);
      setMode("advanced");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/admin/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPayload({
            // Blank means "keep the stored key"; `[]` clears the protocols.
            apiKey: values.apiKey || undefined,
            textSpecs: values.textSpecs,
          }),
        ),
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
        <ProviderForm
          form={form}
          baseUrlRequired={false}
          apiKeyRequired={false}
          modelsActions={
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
  const me = (data.data?.providers ?? []).find(
    (p: { id: string }) => p.id === providerId,
  );
  return (me?.modelMapping ?? {}) as Record<string, string>;
}
