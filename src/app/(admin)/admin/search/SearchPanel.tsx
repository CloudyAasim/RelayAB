"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useT } from "@/components/i18n/I18nProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import type { SearchUsageRow, SearchUsageTotals } from "@/lib/db/usage";

interface Props {
  enabled: boolean;
  storedEnabled: boolean | null;
  creditsPerCall: number;
  storedCredits: number | null;
  backendConfigured: boolean;
  backendName: string | null;
  backendUrl: string | null;
  maxResults: number;
  stats: { last24h: SearchUsageTotals; last7d: SearchUsageTotals; total: SearchUsageTotals };
  recent: SearchUsageRow[];
}

interface TestResult {
  provider: string;
  backend: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  latencyMs: number;
}

/** Storage units are 0.001 积分; the panel speaks whole credits. */
function credits(units: number): string {
  const value = units / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "");
}

export function SearchPanel(props: Props) {
  const t = useT();
  const router = useRouter();

  const [enabled, setEnabled] = useState(props.enabled);
  const [price, setPrice] = useState(String(props.creditsPerCall));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const parsed = Number(price);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setSaveError(t("admin.search.priceInvalid"));
        return;
      }
      const res = await fetch("/api/admin/search", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, creditsPerCall: parsed }),
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

  async function runTest(e: React.FormEvent) {
    e.preventDefault();
    setTesting(true);
    setTestError(null);
    setTest(null);
    try {
      const res = await fetch("/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 5 }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; data?: TestResult; error?: { message?: string } }
        | null;
      if (!data?.ok || !data.data) {
        setTestError(data?.error?.message ?? t("common.failed"));
        return;
      }
      setTest(data.data);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
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
            {props.backendUrl && (
              <div className="mt-1 break-all text-muted-foreground">
                {t("admin.search.status.url")}: <code className="rounded bg-muted px-1">{props.backendUrl}</code>
              </div>
            )}
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

            <Input
              label={t("admin.search.price")}
              type="number"
              min={0}
              step={1}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <p className="-mt-2 text-xs text-muted-foreground">{t("admin.search.priceHint")}</p>

            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
            {saved && <p className="text-sm text-green-600">{t("common.success")}</p>}

            <Button type="submit" loading={saving}>
              {t("common.save")}
            </Button>
          </form>
        </div>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader
          title={t("admin.search.test.title")}
          description={t("admin.search.test.desc")}
        />
        <form onSubmit={runTest} className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1">
            <Input
              label={t("admin.search.test.query")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("admin.search.test.placeholder")}
            />
          </div>
          <Button type="submit" loading={testing} disabled={!query.trim()}>
            {t("admin.search.test.run")}
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t("admin.search.test.unbilled")}</p>

        {testError && <p className="mt-3 text-sm text-destructive">{testError}</p>}
        {test && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("admin.search.test.latency", { ms: test.latencyMs, backend: test.backend })}
            </p>
            {test.results.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("admin.search.test.empty")}</p>
            ) : (
              <ol className="list-decimal space-y-2 pl-5">
                {test.results.map((r) => (
                  <li key={r.url} className="text-sm">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-primary hover:underline"
                    >
                      {r.title}
                    </a>
                    <p className="break-all text-xs text-muted-foreground">{r.url}</p>
                    {r.snippet && <p className="mt-0.5 text-muted-foreground">{r.snippet}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </Card>

      <Card className="max-w-3xl">
        <CardHeader title={t("admin.search.stats.title")} description={t("admin.search.stats.desc")} />
        <div className="grid gap-3 sm:grid-cols-3">
          {(["last24h", "last7d", "total"] as const).map((key) => (
            <div key={key} className="rounded-md border border-border p-3">
              <p className="text-xs text-muted-foreground">{t(`admin.search.stats.${key}`)}</p>
              <p className="mt-1 text-lg font-medium">
                {t("admin.search.stats.calls", { n: props.stats[key].calls })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("admin.search.stats.credits", { n: credits(props.stats[key].creditsUsed) })}
              </p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader title={t("admin.search.recent.title")} />
        {props.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin.search.recent.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t("admin.search.recent.time")}</th>
                  <th className="py-2 pr-3 font-medium">{t("admin.search.recent.user")}</th>
                  <th className="py-2 pr-3 font-medium">{t("admin.search.recent.key")}</th>
                  <th className="py-2 pr-3 font-medium">{t("admin.search.recent.status")}</th>
                  <th className="py-2 font-medium">{t("admin.search.recent.credits")}</th>
                </tr>
              </thead>
              <tbody>
                {props.recent.map((row) => (
                  <tr key={row.id} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">{row.username || "—"}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{row.keyLabel || "—"}</td>
                    <td className="py-2 pr-3">
                      {row.status === "success"
                        ? t("admin.search.recent.success")
                        : t("admin.search.recent.error")}
                    </td>
                    <td className="py-2">{credits(row.creditsUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
