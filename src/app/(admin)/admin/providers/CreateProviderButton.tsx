"use client";

/**
 * src/app/(admin)/admin/providers/CreateProviderButton.tsx
 *
 * Provider creation.
 *
 * What is left here after the refactor is the three things that are genuinely
 * about *creating*: the template picker, fetching models with the key being
 * typed in right now, and POSTing. The fields, the state and the request body
 * all come from `ProviderForm` / `useProviderForm` — the same ones the edit
 * modal uses, which is the point: the two used to be separate hand-written
 * forms and they drifted apart in ways only one of them noticed.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LegacyModal as Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { PROVIDER_TEMPLATES } from "@/lib/providers/templates";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  mergeFetchedModels,
  newModelRow,
} from "./model-rows";
import { ProviderForm } from "./form/ProviderForm";
import { useProviderForm } from "./form/use-provider-form";

interface Props {
  onCreated?: () => void;
}

export function CreateProviderButton({ onCreated }: Props) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const [templateId, setTemplateId] = useState("openai");
  const form = useProviderForm();
  const { values, patch, setModelRows, specVerdict, setMode, buildPayload, reset } = form;

  // Fetch-models state
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchResult, setFetchResult] = useState<{
    count: number;
    status: number;
    latencyMs: number;
    error?: string;
  } | null>(null);

  // Submit state
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Context/output defaults for rows added by hand follow the selected template.
  const activeTemplateModelDefaults = (() => {
    const tpl = PROVIDER_TEMPLATES.find((x) => x.id === templateId);
    return {
      contextLength: tpl?.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH,
      maxOutputTokens: tpl?.defaultMaxOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  })();

  function applyTemplate(id: string) {
    const tpl = PROVIDER_TEMPLATES.find((x) => x.id === id);
    if (!tpl) return;
    setTemplateId(id);
    patch({
      kind: tpl.kind === "azure" ? "custom-openai" : tpl.kind,
      ...(tpl.defaultBaseUrl ? { baseUrl: tpl.defaultBaseUrl } : {}),
    });
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
  }

  async function fetchModels() {
    if (!values.baseUrl || !values.apiKey) return;
    setFetchingModels(true);
    try {
      const res = await fetch("/api/admin/providers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: values.baseUrl,
          apiKey: values.apiKey,
          kind: values.kind,
        }),
      });
      const text = await res.text();
      if (!text) {
        setFetchResult({
          count: 0,
          status: res.status,
          latencyMs: 0,
          error: t("common.networkError") + " (empty response)",
        });
        return;
      }
      let data: {
        ok?: boolean;
        models?: string[];
        status?: number;
        latencyMs?: number;
        error?: string;
      };
      try {
        data = JSON.parse(text);
      } catch {
        setFetchResult({
          count: 0,
          status: res.status,
          latencyMs: 0,
          error: t("common.networkError") + " (invalid JSON: " + text.slice(0, 100) + ")",
        });
        return;
      }
      if (data.ok) {
        setFetchResult({
          count: data.models?.length ?? 0,
          status: data.status ?? 0,
          latencyMs: data.latencyMs ?? 0,
        });
        setModelRows((prev) => mergeFetchedModels(prev, data.models ?? [], activeTemplateModelDefaults));
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

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!specVerdict.ok) {
      setError(specVerdict.errors[0]);
      setMode("advanced");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildPayload({
            // An unnamed provider falls back to the template it was built from.
            nameFallback: templateId,
            // "Nothing configured" is the absence of the field, not an empty
            // list — unlike edit, where `[]` is how a list gets cleared.
            textSpecs: values.textSpecs.length ? values.textSpecs : undefined,
          }),
        ),
      });

      const text = await res.text();
      if (!text) {
        setError(t("common.networkError") + " (empty response)");
        return;
      }
      let data: { ok?: boolean; error?: { message?: string } };
      try {
        data = JSON.parse(text);
      } catch {
        setError(t("common.networkError") + " (invalid server response)");
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
      <Button
        onClick={() => {
          reset();
          setTemplateId("openai");
          setError(null);
          setOpen(true);
        }}
      >
        {t("admin.providers.create")}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("admin.providers.create")} extraWide>
        <form onSubmit={onSubmit} className="space-y-4">
          <ProviderForm
            form={form}
            newRowDefaults={activeTemplateModelDefaults}
            aboveFields={
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  {t("admin.providers.create.template")}
                </label>
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
                  {PROVIDER_TEMPLATES.find((x) => x.id === templateId)?.description}
                </p>
              </div>
            }
            modelsActions={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={fetchModels}
                loading={fetchingModels}
                disabled={!values.baseUrl || !values.apiKey}
              >
                ↻ {t("admin.providers.create.autoFetch")}
              </Button>
            }
            modelsHint={
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
