"use client";

import { useState } from "react";

import { useT } from "@/components/i18n/I18nProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LegacyModal as Modal } from "@/components/ui/Modal";

interface TestResult {
  backend: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  latencyMs: number;
}

/**
 * One query, through one provider, not billed.
 *
 * A modal rather than a fixed diagnostic query: "does this vendor answer *my*
 * kinds of searches" is the question, and a hardcoded one answers a different
 * one.
 */
export function SearchProviderTestModal({
  providerId,
  providerName,
  open,
  onClose,
}: {
  providerId: string;
  providerName: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/search-providers/${providerId}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: 5 }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; data?: TestResult; error?: { message?: string } }
        | null;
      if (!data?.ok || !data.data) {
        setError(data?.error?.message ?? t("common.failed"));
        return;
      }
      setResult(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("admin.searchProviders.testTitle", { name: providerName })}
      description={t("admin.searchProviders.testHint")}
      wide
    >
      <form onSubmit={run} className="space-y-4">
        <Input
          label={t("admin.searchProviders.testQuery")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("admin.search.test.placeholder")}
          required
        />
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy} disabled={!query.trim()}>
            {t("admin.searchProviders.test")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("admin.searchProviders.testUnbilled")}
          </span>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      {result && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-muted-foreground">
            {t("admin.search.test.latency", { ms: result.latencyMs, backend: result.backend })}
          </p>
          {result.results.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("admin.search.test.empty")}</p>
          ) : (
            <ol className="list-decimal space-y-2 pl-5">
              {result.results.map((r) => (
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
    </Modal>
  );
}
