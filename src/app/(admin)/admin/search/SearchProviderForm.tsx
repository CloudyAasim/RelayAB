"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n/I18nProvider";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";

/** The vendors that ship with a template, plus whatever a row names itself. */
export const BUILTIN_KINDS = ["searxng", "tavily", "brave", "openai-compatible"] as const;

export interface SearchTemplateOption {
  id: string;
  name: string;
  description: string;
  spec: unknown;
}

export interface SearchProviderRow {
  id: string;
  name: string;
  /** The name a client uses to ask for this service. */
  serviceId?: string;
  /** Whether this is the service a caller gets when they do not name one. */
  isDefault?: boolean;
  kind: string;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  /** Whole credits this backend charges per call. */
  creditsPerCall: number;
  hasApiKey: boolean;
  /** The row's own spec, when it has one. */
  spec?: unknown;
}

interface Props {
  /** Present → edit mode (PATCH); absent → create mode (POST). */
  provider?: SearchProviderRow;
  /** Starting points shown as buttons. */
  templates?: SearchTemplateOption[];
  onSaved?: () => void;
}

/**
 * Add or edit one search backend.
 *
 * The screen is the search adapter protocol made concrete: a backend is a
 * name, an address, a credential and — when the vendor is one this build has
 * no template for — a spec.
 *
 * **The address means one thing.** It is the *service root*, and the spec's
 * path says where the service keeps its search endpoint. That is the change
 * from before, when the same column held a whole endpoint for Tavily and
 * Brave and a service root for SearXNG, and nothing said so. The resolved
 * endpoint is shown under the field, so "where does this actually go" is
 * something the operator reads rather than infers.
 *
 * A row that predates the protocol has no spec, and the form leaves it that
 * way until somebody asks for a template — its address keeps the old meaning
 * until then, so editing a price cannot change where a request goes.
 */
export function SearchProviderForm({ provider, templates, onSaved }: Props) {
  const t = useT();
  const router = useRouter();
  const editing = Boolean(provider);

  const [name, setName] = useState(provider?.name ?? "");
  const [serviceId, setServiceId] = useState(provider?.serviceId ?? "");
  const [kind, setKind] = useState<string>(provider?.kind ?? "searxng");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(String(provider?.priority ?? 1));
  const [creditsPerCall, setCreditsPerCall] = useState(String(provider?.creditsPerCall ?? 1));
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [specText, setSpecText] = useState(
    provider?.spec ? JSON.stringify(provider.spec, null, 2) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const hasSpec = specText.trim().length > 0;

  /**
   * The vendor the spec names.
   *
   * A row that carries its own spec is free to be any vendor, and the spec
   * says which one — so the `kind` follows the spec rather than the other way
   * round. A form that let the two disagree would record a row whose usage
   * statistics name a vendor the request never went to.
   */
  const specVendor: string | null = (() => {
    if (!hasSpec) return null;
    try {
      const parsed = JSON.parse(specText) as { vendor?: unknown };
      return typeof parsed.vendor === "string" && parsed.vendor.trim() ? parsed.vendor.trim() : null;
    } catch {
      return null;
    }
  })();

  /**
   * The endpoint this row would talk to, as far as the form can tell.
   *
   * **The same rules the server uses** (`effectiveSearchConfig`), because a
   * preview that shows an address nobody will request is worse than no
   * preview: the form used to treat every address as a service root, so a
   * Tavily row written before the protocol — whose address is the *whole
   * endpoint* — was previewed as `…/search/search`, a URL that is never
   * requested.
   *
   * Three cases, and they are the three the server has:
   *
   *  - a row with a spec: the address is the root and the spec's path is
   *    appended — unless the path is empty, which means the address *is* the
   *    endpoint;
   *  - a row without a spec, written before the protocol: Tavily and Brave
   *    stored the whole endpoint, SearXNG stored the service root;
   *  - a row with neither: the template's own default, if it has one.
   */
  function resolvedEndpoint(): string | null {
    const root = baseUrl.trim();
    if (!hasSpec) {
      if (kind === "searxng") return root ? `${root.replace(/\/+$/, "")}/search` : null;
      if (kind === "tavily") return root || "https://api.tavily.com/search";
      if (kind === "brave") return root || "https://api.search.brave.com/res/v1/web/search";
      // The OpenAI-compatible address is the endpoint itself: nothing is
      // appended to it, so there is no default to show without one.
      if (kind === "openai-compatible") return root || null;
      return null;
    }
    try {
      const spec = JSON.parse(specText) as { transport?: { path?: string }; baseUrl?: string };
      const base = root || spec.baseUrl?.trim() || "";
      if (!base) return null;
      const path = spec.transport?.path ?? "";
      if (!path) return base;
      return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
    } catch {
      return null;
    }
  }

  function loadTemplate(template: SearchTemplateOption): void {
    setName(template.name);
    setKind(template.id);
    setSpecText(JSON.stringify(template.spec, null, 2));
    const spec = template.spec as { baseUrl?: string };
    // The template's address is a service root. Loading a template therefore
    // replaces an address that used to be a whole endpoint — otherwise the
    // root and the path would be added together and the request would go to
    // `…/search/search`.
    setBaseUrl(spec.baseUrl?.trim() ?? "");
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const parsedCredits = Number(creditsPerCall);
      if (!Number.isInteger(parsedCredits) || parsedCredits < 0) {
        setError(t("admin.searchProviders.creditsInvalid"));
        return;
      }
      /**
       * The priority, read as a number **or left alone**.
       *
       * It used to be `Number(priority) || 0`, which turned an empty box into
       * zero — the highest priority in the deployment — and did it silently,
       * on every save, including the ones where the operator had come to
       * change the name. A blank field now means "do not touch it".
       */
      const trimmedPriority = priority.trim();
      let parsedPriority: number | undefined;
      if (trimmedPriority !== "") {
        const n = Number(trimmedPriority);
        if (!Number.isInteger(n) || n < 0) {
          setError(t("admin.searchProviders.priorityInvalid"));
          return;
        }
        parsedPriority = n;
      }
      const payload: Record<string, unknown> = {
        name: name.trim(),
        // The spec names the vendor; the dropdown only matters for a row that
        // uses a built-in template.
        kind: specVendor ?? kind,
        baseUrl: baseUrl.trim(),
        enabled,
        creditsPerCall: parsedCredits,
      };
      if (parsedPriority !== undefined) payload.priority = parsedPriority;
      // A blank client name means "keep the one this row already has" — a
      // service that cannot be named is still the deployment's service.
      if (serviceId.trim()) payload.serviceId = serviceId.trim();
      if (hasSpec) {
        payload.spec = JSON.parse(specText);
      }
      // A blank key in edit mode means "keep the stored one".
      if (apiKey.trim() || !editing) payload.apiKey = apiKey.trim();

      const res = await fetch(
        editing
          ? `/api/admin/search-providers/${provider!.id}`
          : "/api/admin/search-providers",
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

  const endpoint = resolvedEndpoint();

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("admin.searchProviders.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Input
          label={t("admin.searchProviders.serviceId")}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          placeholder="searxng"
          hint={t("admin.searchProviders.serviceIdHint")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-medium">
            {t("admin.searchProviders.kind")}
          </label>
          <select
            value={specVendor ?? kind}
            onChange={(e) => setKind(e.target.value)}
            disabled={Boolean(specVendor)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-70"
          >
            {BUILTIN_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`admin.searchProviders.kinds.${k}`)}
              </option>
            ))}
            {specVendor && !BUILTIN_KINDS.includes(specVendor as (typeof BUILTIN_KINDS)[number]) && (
              <option value={specVendor}>{specVendor}</option>
            )}
            {!specVendor && !BUILTIN_KINDS.includes(kind as (typeof BUILTIN_KINDS)[number]) && (
              <option value={kind}>{kind}</option>
            )}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {specVendor
              ? t("admin.searchProviders.kindHintFromSpec")
              : t("admin.searchProviders.kindHint")}
          </p>
        </div>
      </div>

      <Input
        label={t("admin.searchProviders.baseUrl")}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={kind === "searxng" ? "http://relay-search.web:8080" : "https://api.example.com"}
        hint={
          endpoint
            ? `${t("admin.searchProviders.baseUrlHint")} → ${endpoint}`
            : t("admin.searchProviders.baseUrlHint")
        }
      />

      <Input
        type="password"
        label={`${t("admin.searchProviders.apiKey")} (${t("admin.providers.edit.leaveBlank")})`}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={editing ? "••••••" : ""}
        hint={t("admin.searchProviders.apiKeyHint")}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          label={t("admin.searchProviders.priority")}
          type="number"
          min={0}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          hint={t("admin.searchProviders.priorityHint")}
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

      <label className="block space-y-1">
        <span className="flex flex-wrap items-center gap-3 text-sm font-medium text-foreground">
          {t("admin.searchProviders.spec")}
          {templates &&
            templates.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => loadTemplate(template)}
                title={template.description}
                className="text-xs font-normal text-primary hover:underline"
              >
                {template.name}
              </button>
            ))}
        </span>
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          rows={14}
          spellCheck={false}
          placeholder={'{\n  "specVersion": 1,\n  "transport": { … }\n}'}
          className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        />
        <span className="block text-xs text-muted-foreground">{t("admin.searchProviders.specHint")}</span>
      </label>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          {t("admin.searchProviders.saved")}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button type="button" loading={busy} onClick={save}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
