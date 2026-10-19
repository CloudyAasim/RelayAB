"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n/I18nProvider";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export type SearchProviderKind = "tavily" | "brave" | "searxng";

export interface SearchProviderRow {
  id: string;
  name: string;
  kind: SearchProviderKind;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  /** Whole credits this backend charges per call. */
  creditsPerCall: number;
  hasApiKey: boolean;
}

interface Props {
  provider?: SearchProviderRow;
  onSaved?: () => void;
}

/**
 * Add or edit one search backend.
 *
 * The two kinds need different required fields, and saying so in the form is
 * better than letting the API refuse it after a save: a SearXNG row needs an
 * address, Tavily and Brave need a key. The API enforces the same rule, so the
 * form is a convenience rather than the only guard.
 */
export function SearchProviderForm({ provider, onSaved }: Props) {
  const t = useT();
  const router = useRouter();
  const editing = Boolean(provider);

  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<SearchProviderKind>(provider?.kind ?? "searxng");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(String(provider?.priority ?? 1));
  const [creditsPerCall, setCreditsPerCall] = useState(String(provider?.creditsPerCall ?? 1));
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const keyRequired = kind !== "searxng";
  const urlRequired = kind === "searxng";

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const parsedCredits = Number(creditsPerCall);
      if (!Number.isInteger(parsedCredits) || parsedCredits < 0) {
        setError(t("admin.searchProviders.creditsInvalid"));
        return;
      }
      const payload: Record<string, unknown> = {
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim(),
        enabled,
        priority: Number(priority) || 0,
        creditsPerCall: parsedCredits,
      };
      // A blank key on edit means "keep the stored one", so it is omitted
      // rather than sent as an empty string.
      if (apiKey.trim() || !editing) payload.apiKey = apiKey.trim();

      const res = await fetch(
        editing ? `/api/admin/search-providers/${provider!.id}` : "/api/admin/search-providers",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!data?.ok) {
        setError(data?.error?.message ?? t("common.failed"));
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
    <form onSubmit={save} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("admin.searchProviders.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {t("admin.searchProviders.kind")}
          </label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SearchProviderKind)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="searxng">{t("admin.searchProviders.kinds.searxng")}</option>
            <option value="tavily">{t("admin.searchProviders.kinds.tavily")}</option>
            <option value="brave">{t("admin.searchProviders.kinds.brave")}</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("admin.searchProviders.kindHint")}
          </p>
        </div>
      </div>

      <Input
        label={t("admin.searchProviders.baseUrl")}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={kind === "searxng" ? "http://relay-search.web:8080" : "https://..."}
        required={urlRequired}
        hint={t("admin.searchProviders.baseUrlHint")}
      />

      <Input
        type="password"
        label={
          keyRequired || editing
            ? `${t("admin.searchProviders.apiKey")} (${t("admin.providers.edit.leaveBlank")})`
            : t("admin.searchProviders.apiKey")
        }
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        required={keyRequired && !editing}
        hint={t("admin.searchProviders.apiKeyHint")}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          label={t("admin.searchProviders.priority")}
          type="number"
          min={0}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <Input
          label={t("admin.searchProviders.creditsPerCall")}
          type="number"
          min={0}
          step={1}
          value={creditsPerCall}
          onChange={(e) => setCreditsPerCall(e.target.value)}
          hint={t("admin.searchProviders.creditsHint")}
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

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-green-600">{t("common.success")}</p>}

      <Button type="submit" loading={busy}>
        {t("common.save")}
      </Button>
    </form>
  );
}
