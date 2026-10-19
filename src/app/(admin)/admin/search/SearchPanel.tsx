"use client";

/**
 * The feature-wide switch, and the price of the environment fallback.
 *
 * Price belongs to a provider row: two backends can have very different
 * economics, so one global number would either overcharge the cheap one or
 * lose money on the expensive one. The only case without a row is the
 * environment fallback (`SEARXNG_URL` / `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`),
 * and that is the only case where the price is still edited here.
 *
 * The query box that used to live on this page is now part of the single
 * "测试" page, next to the model testers — one place to try the things this
 * gateway fronts.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n/I18nProvider";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

interface Props {
  enabled: boolean;
  storedEnabled: boolean | null;
  /** The effective price, whichever source produced it. */
  creditsPerCall: number;
  /** True when that price came from the active provider row. */
  creditsFromProvider: boolean;
  storedCredits: number | null;
  backendConfigured: boolean;
  backendName: string | null;
  backendUrl: string | null;
  backendSource: "db" | "env" | null;
  providerCount: number;
}

export function SearchPanel(props: Props) {
  const t = useT();
  const router = useRouter();

  const [enabled, setEnabled] = useState(props.enabled);
  const [price, setPrice] = useState(String(props.creditsPerCall));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const body: { enabled: boolean; creditsPerCall?: number } = { enabled };
      // A provider-owned price is not this form's to write: sending one would
      // silently change the fallback price behind the operator's back.
      if (!props.creditsFromProvider) {
        const parsed = Number(price);
        if (!Number.isInteger(parsed) || parsed < 0) {
          setSaveError(t("admin.search.priceInvalid"));
          return;
        }
        body.creditsPerCall = parsed;
      }
      const res = await fetch("/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!data?.ok) {
        setSaveError(data?.error?.message ?? t("common.failed"));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setSaving(false);
    }
  }

  const sourceLabel =
    props.backendSource === "db"
      ? t("admin.search.status.sourceDb", { count: props.providerCount })
      : props.backendSource === "env"
        ? t("admin.search.status.sourceEnv")
        : null;

  return (
    <Card className="max-w-3xl">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">{t("admin.search.status.title")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.search.desc")}</p>
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground">{t("admin.search.status.backend")}:</span>
            {props.backendConfigured ? (
              <span className="font-medium">
                {t("admin.search.status.backendConfigured", { name: props.backendName ?? "" })}
              </span>
            ) : (
              <span className="text-destructive">{t("admin.search.status.backendMissing")}</span>
            )}
          </div>
          {sourceLabel && <div className="mt-1 text-muted-foreground">{sourceLabel}</div>}
          {props.backendUrl && (
            <div className="mt-1 break-all text-muted-foreground">
              {t("admin.search.status.url")}: <code className="rounded bg-muted px-1">{props.backendUrl}</code>
            </div>
          )}
          <div className="mt-1 text-muted-foreground">
            {props.creditsFromProvider
              ? t("admin.search.status.priceFromProvider", { credits: props.creditsPerCall })
              : t("admin.search.status.priceFallback", { credits: props.creditsPerCall })}
          </div>
          {props.storedEnabled === null && (
            <p className="mt-1 text-xs text-muted-foreground">{t("admin.search.status.defaultOn")}</p>
          )}
        </div>

        <form onSubmit={save} className="space-y-4">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
            />
            {t("admin.search.status.enabled")}
          </label>
          <p className="-mt-2 text-xs text-muted-foreground">{t("admin.search.status.enabledHint")}</p>

          {!props.creditsFromProvider && (
            <>
              <Input
                label={t("admin.search.price")}
                type="number"
                min={0}
                step={1}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
              <p className="-mt-2 text-xs text-muted-foreground">{t("admin.search.priceHint")}</p>
            </>
          )}

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          {saved && <p className="text-sm text-green-600">{t("common.success")}</p>}

          <Button type="submit" loading={saving}>
            {t("common.save")}
          </Button>
        </form>
      </div>
    </Card>
  );
}
