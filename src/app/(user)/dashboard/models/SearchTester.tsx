"use client";

/**
 * Try a search backend, in the same three configurations the model testers use:
 *
 *   本账号      the deployment's own search, billed to this account (admin only)
 *   服务密钥    paste an `sk-relay-…` key and call `/v1/search` with it
 *   其他服务商  ask a vendor directly, with that vendor's own parameters
 *
 * The configuration names used to be 本站搜索 / 其他服务商 here, which read as a
 * different concept from the one on the text and media tabs; they are the same
 * question ("who answers, and who pays"), so they are the same three choices.
 *
 * The account path is admin-only and **billed**: it goes through the same
 * settlement as `POST /v1/search`, so the account that presses the button pays
 * the price and the call shows up in the usage tables.
 */
import { useState } from "react";

import { Card, CardHeader } from "@/components/ui/Card";
import { OtherSearchProbe, type OtherSearchLabels } from "./OtherSearchProbe";
import type { RawRequestLabels } from "./RawRequestPanel";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export interface SearchTestLabels {
  title: string;
  desc: string;
  query: string;
  placeholder: string;
  run: string;
  billed: string;
  charged: string;
  latency: string;
  empty: string;
  unavailable: string;
  failed: string;
  /** The label of the service picker, when there is more than one. */
  whichService: string;
  /** The picker's "nobody chose" entry. */
  whichServiceNone: string;
  /** The picker's entry when the deployment has exactly one service. */
  whichServiceNoneOne: string;
}

interface TestResult {
  provider: string;
  backend: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  latencyMs: number;
  credits: number;
  remaining: number | null;
}

type Mode = "account" | "key" | "other";

/** `/v1/search` and the admin route both cap the result count at this. */
const OWN_SEARCH_MAX = 8;

export function SearchTester({
  embedded = false,
  isAdmin = false,
  otherLabels,
  rawLabels,
  config,
  resultCount,
  limitHint,
  serviceKey,
  notAdmin,
  labels,
  backendName,
  services = [],
}: {
  /** Rendered inside the test card's tab instead of its own card. */
  embedded?: boolean;
  /** Only an administrator may run the deployment's own search. */
  isAdmin?: boolean;
  labels: SearchTestLabels;
  /** The 其他服务商 form's labels. */
  otherLabels: OtherSearchLabels;
  rawLabels: RawRequestLabels;
  /** What the three configurations are called. */
  config: { account: string; key: string; other: string };
  resultCount: string;
  limitHint: string;
  serviceKey: string;
  notAdmin: string;
  /** The backend `/v1/search` is using, or null when none is configured. */
  backendName: string | null;
  /** The deployment's search services, by client-visible names. */
  services?: Array<{ id: string; name: string }>;
}) {
  const [mode, setMode] = useState<Mode>(isAdmin ? "account" : "key");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("6");
  const [relayKey, setRelayKey] = useState("");
  const [service, setService] = useState("");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const available = Boolean(backendName);

  async function runAccount(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      const res = await fetch("/api/admin/search/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: Number(limit) || 6, ...(service ? { service } : {}) }),
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

  async function runKey(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!relayKey.trim()) return;
    setTesting(true);
    setError(null);
    setRaw(null);
    setLatency(null);
    const started = Date.now();
    try {
      const res = await fetch("/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey.trim()}`,
        },
        body: JSON.stringify({ query, limit: Math.min(Number(limit) || 6, OWN_SEARCH_MAX) }),
      });
      const body = await res.json().catch(() => null);
      setLatency(Date.now() - started);
      if (!res.ok) {
        setError((body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setRaw(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.failed);
    } finally {
      setTesting(false);
    }
  }

  const content = (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="sr-only">{config.account}</legend>
        {(
          [
            { id: "account" as const, label: config.account, disabled: !isAdmin },
            { id: "key" as const, label: config.key, disabled: false },
            { id: "other" as const, label: config.other, disabled: false },
          ]
        ).map((entry) => (
          <label
            key={entry.id}
            className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${
              mode === entry.id
                ? "border-primary bg-primary/5 font-medium text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/50"
            } ${entry.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
          >
            <input
              type="radio"
              name="search-config"
              className="mt-0.5 accent-primary"
              checked={mode === entry.id}
              disabled={entry.disabled}
              onChange={() => setMode(entry.id)}
            />
            <span>
              {entry.label}
              {entry.id === "account" && !isAdmin && (
                <span className="block text-xs text-muted-foreground">{notAdmin}</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "other" ? (
        <OtherSearchProbe labels={otherLabels} rawLabels={rawLabels} />
      ) : mode === "key" ? (
        <form onSubmit={runKey} className="space-y-3">
          <Input
            label={serviceKey}
            type="password"
            autoComplete="off"
            placeholder="sk-relay-..."
            value={relayKey}
            onChange={(e) => setRelayKey(e.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
            <Input
              label={labels.query}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={labels.placeholder}
            />
            <Input
              label={resultCount}
              type="number"
              min={1}
              max={OWN_SEARCH_MAX}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-2">
            <p className="text-xs text-muted-foreground">POST /v1/search</p>
            <code className="break-all text-xs text-foreground">Authorization: Bearer sk-relay-…</code>
          </div>
          <p className="text-xs text-muted-foreground">{limitHint}</p>
          <Button type="submit" loading={testing} disabled={!query.trim() || !relayKey.trim()}>
            {labels.run}
          </Button>
        </form>
      ) : !available ? (
        <p className="text-sm text-muted-foreground">{labels.unavailable}</p>
      ) : (
        <>
          <form onSubmit={runAccount} className="flex flex-wrap items-end gap-2">
            {services.length > 0 && (
              <div className="min-w-[200px]">
                <label className="mb-1.5 block text-sm font-medium" htmlFor="search-test-service">
                  {labels.whichService}
                </label>
                <select
                  id="search-test-service"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">
                    {services.length === 1 ? labels.whichServiceNoneOne : labels.whichServiceNone}
                  </option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="min-w-[240px] flex-1">
              <Input
                label={labels.query}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={labels.placeholder}
              />
            </div>
            <div className="w-28">
              <Input
                label={resultCount}
                type="number"
                min={1}
                max={OWN_SEARCH_MAX}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </div>
            <Button type="submit" loading={testing} disabled={!query.trim()}>
              {labels.run}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">{labels.billed}</p>
          <p className="text-xs text-muted-foreground">{limitHint}</p>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {test && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {labels.latency.replace("{ms}", String(test.latencyMs)).replace("{backend}", test.backend)}
          </p>
          <p className="text-sm text-muted-foreground">
            {labels.charged
              .replace("{credits}", String(test.credits))
              .replace("{remaining}", String(test.remaining ?? 0))}
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

      {raw !== null && (
        <div className="space-y-2">
          {latency !== null && (
            <p className="text-sm text-muted-foreground">{latency} ms</p>
          )}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-xs">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );

  if (embedded) return content;
  return (
    <Card>
      <CardHeader title={labels.title} description={labels.desc} />
      {content}
    </Card>
  );
}
