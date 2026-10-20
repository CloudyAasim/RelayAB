"use client";

/**
 * The environment fallback's price, editable only while it is the thing being
 * used.
 *
 * The fallback is the `SEARXNG_URL` / `TAVILY_API_KEY` /
 * `BRAVE_SEARCH_API_KEY` path — the one a deployment uses before it has any
 * provider row. Its price is the only number that is not on a row, and it
 * only matters while there are no rows, so it is shown in the empty state and
 * nowhere else.
 *
 * A deployment that has rows never reaches this: the price comes from the row
 * that answers.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n/I18nProvider";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function EnvFallbackPrice({
  creditsPerCall,
  envConfigured,
}: {
  /** The stored price, or null when it has never been set. */
  creditsPerCall: number | null;
  /** Whether an environment fallback is configured at all. */
  envConfigured: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [price, setPrice] = useState(String(creditsPerCall ?? 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const parsed = Number(price);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError(t("admin.search.priceInvalid"));
        return;
      }
      const res = await fetch("/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsPerCall: parsed }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: { message?: string } }
        | null;
      if (!data?.ok) {
        setError(data?.error?.message ?? t("common.failed"));
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-3xl">
      <form onSubmit={save} className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">{t("admin.search.fallback.title")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {envConfigured
              ? t("admin.search.fallback.configured")
              : t("admin.search.fallback.notConfigured")}
          </p>
        </div>

        <Input
          label={t("admin.search.price")}
          type="number"
          min={0}
          step={1}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          hint={t("admin.search.priceHint")}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}
        {saved && <p className="text-sm text-green-600">{t("common.success")}</p>}

        <Button type="submit" loading={saving}>
          {t("common.save")}
        </Button>
      </form>
    </Card>
  );
}
