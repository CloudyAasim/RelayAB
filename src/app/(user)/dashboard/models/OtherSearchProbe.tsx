"use client";

/**
 * 其他服务商, search: ask a search backend the way its own documentation does.
 *
 * The four kinds are the shapes this deployment already speaks in its search
 * adapter protocol; a vendor outside them is one raw request away.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RawRequestPanel, type RawRequestLabels } from "./RawRequestPanel";

type Kind = "searxng" | "tavily" | "brave" | "openai-compatible";

const DEFAULTS: Record<Kind, string> = {
  searxng: "http://relay-search.web:8080",
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  "openai-compatible": "",
};

export interface OtherSearchLabels {
  title: string;
  hint: string;
  kind: string;
  kinds: Record<Kind, string>;
  baseUrl: string;
  apiKey: string;
  query: string;
  limit: string;
  endpoint: string;
  run: string;
  running: string;
  ok: string;
  failed: string;
  raw: string;
}

interface Result {
  endpoint: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  json?: unknown;
  text?: string;
  error?: string;
}

export function OtherSearchProbe({
  labels,
  rawLabels,
}: {
  labels: OtherSearchLabels;
  rawLabels: RawRequestLabels;
}) {
  const [kind, setKind] = useState<Kind>("searxng");
  const [baseUrl, setBaseUrl] = useState(DEFAULTS.searxng);
  const [apiKey, setApiKey] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("5");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const endpoint = useMemo(() => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    if (!base) return kind === "searxng" ? "/search" : "";
    return kind === "searxng" ? `${base}/search` : base;
  }, [baseUrl, kind]);

  const canRun = Boolean(!busy && baseUrl.trim() && query.trim());

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/models/probe-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          query: query.trim(),
          limit: Number(limit) || 5,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: Result; error?: { message?: string } }
        | null;
      if (!json?.ok || !json.data) {
        setResult({ endpoint, ok: false, status: 0, latencyMs: 0, error: json?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setResult(json.data);
    } catch (err) {
      setResult({ endpoint, ok: false, status: 0, latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
        {labels.hint}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="other-search-kind" className="mb-1.5 block text-sm font-medium text-foreground">
            {labels.kind}
          </label>
          <select
            id="other-search-kind"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as Kind;
              setKind(next);
              setBaseUrl(DEFAULTS[next]);
            }}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {(Object.keys(labels.kinds) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {labels.kinds[k]}
              </option>
            ))}
          </select>
        </div>
        <Input
          label={labels.limit}
          type="number"
          min={1}
          max={20}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </div>

      <Input
        label={labels.baseUrl}
        placeholder={DEFAULTS[kind] || "https://api.example.com/v1/search"}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <Input
        label={labels.apiKey}
        type="password"
        autoComplete="off"
        placeholder="sk-..."
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <Input
        label={labels.query}
        placeholder="searxng 文档"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="rounded-md border border-border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">{labels.endpoint}</p>
        <code className="break-all text-xs text-foreground">
          {kind === "searxng" || kind === "brave" ? "GET" : "POST"} {endpoint || "—"}
        </code>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={run} disabled={!canRun}>
          {busy ? labels.running : labels.run}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
          {labels.raw} {showRaw ? "▾" : "▸"}
        </Button>
      </div>

      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <p className="font-medium">
            {result.ok ? labels.ok : labels.failed}
            <span className="ml-2 text-xs text-muted-foreground">
              HTTP {result.status} · {result.latencyMs} ms
            </span>
          </p>
          <p className="break-all text-xs text-muted-foreground">{result.endpoint}</p>
          {result.error && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">{result.error}</pre>
          )}
          {result.json !== undefined && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
              {JSON.stringify(result.json, null, 2)}
            </pre>
          )}
          {result.text !== undefined && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
              {result.text}
            </pre>
          )}
        </div>
      )}

      {showRaw && <RawRequestPanel labels={rawLabels} />}
    </div>
  );
}
