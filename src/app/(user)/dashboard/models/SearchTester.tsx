"use client";

/**
 * Try the deployment's active web-search backend.
 *
 * This used to be a card on the admin search page, which meant "test a model"
 * and "test a search" were two pages for the same question. It now sits next
 * to the model testers, where the answer belongs.
 *
 * The route behind it is admin-only and unbilled, and it always runs through
 * whichever backend currently serves `/v1/search` — not a provider the operator
 * typed in here — so what the box reports is what a real call would get.
 */
import { useState } from "react";

import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export interface SearchTestLabels {
  title: string;
  desc: string;
  query: string;
  placeholder: string;
  run: string;
  unbilled: string;
  latency: string;
  empty: string;
  unavailable: string;
  failed: string;
}

interface TestResult {
  provider: string;
  backend: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  latencyMs: number;
}

export function SearchTester({
  labels,
  backendName,
}: {
  labels: SearchTestLabels;
  /** The backend `/v1/search` is using, or null when none is configured. */
  backendName: string | null;
}) {
  const [query, setQuery] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  async function run(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setTesting(true);
    setError(null);
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
        setError(data?.error?.message ?? labels.failed);
        return;
      }
      setTest(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.failed);
    } finally {
      setTesting(false);
    }
  }

  const available = Boolean(backendName);

  return (
    <Card>
      <CardHeader title={labels.title} description={labels.desc} />

      {!available ? (
        <p className="text-sm text-muted-foreground">{labels.unavailable}</p>
      ) : (
        <>
          <form onSubmit={run} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <Input
                label={labels.query}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={labels.placeholder}
              />
            </div>
            <Button type="submit" loading={testing} disabled={!query.trim()}>
              {labels.run}
            </Button>
          </form>
          <p className="mt-2 text-xs text-muted-foreground">{labels.unbilled}</p>

          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {test && (
            <div className="mt-4 space-y-2">
              <p className="text-sm text-muted-foreground">
                {labels.latency.replace("{ms}", String(test.latencyMs)).replace("{backend}", test.backend)}
              </p>
              {test.results.length === 0 ? (
                <p className="text-sm text-muted-foreground">{labels.empty}</p>
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
        </>
      )}
    </Card>
  );
}
