"use client";

/**
 * 其他服务商, search: ask a search backend the way its own documentation does,
 * with that backend's own optional parameters — not just a query and a count.
 *
 * A tester that only sends `q` cannot answer "does this instance honour
 * `time_range`", which is the question an operator with a search provider row
 * actually has. The fields shown follow the selected kind, because the four
 * shapes do not share a parameter set.
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
  options: string;
  language: string;
  safesearch: string;
  timeRange: string;
  categories: string;
  pageno: string;
  searchDepth: string;
  topic: string;
  includeAnswer: string;
  includeRawContent: string;
  days: string;
  country: string;
  freshness: string;
  extraSnippets: string;
  offset: string;
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

  const [language, setLanguage] = useState("");
  const [safesearch, setSafesearch] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [categories, setCategories] = useState("");
  const [pageno, setPageno] = useState("");
  const [searchDepth, setSearchDepth] = useState("");
  const [topic, setTopic] = useState("");
  const [includeAnswer, setIncludeAnswer] = useState(false);
  const [includeRawContent, setIncludeRawContent] = useState(false);
  const [days, setDays] = useState("");
  const [country, setCountry] = useState("");
  const [freshness, setFreshness] = useState("");
  const [extraSnippets, setExtraSnippets] = useState(false);
  const [offset, setOffset] = useState("");

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
          ...(language.trim() ? { language: language.trim() } : {}),
          ...(safesearch ? { safesearch } : {}),
          ...(timeRange ? { timeRange } : {}),
          ...(categories.trim() ? { categories: categories.trim() } : {}),
          ...(pageno ? { pageno: Number(pageno) } : {}),
          ...(searchDepth ? { searchDepth } : {}),
          ...(topic ? { topic } : {}),
          ...(includeAnswer ? { includeAnswer: true } : {}),
          ...(includeRawContent ? { includeRawContent: true } : {}),
          ...(days ? { days: Number(days) } : {}),
          ...(country.trim() ? { country: country.trim() } : {}),
          ...(freshness ? { freshness } : {}),
          ...(extraSnippets ? { extraSnippets: true } : {}),
          ...(offset ? { offset: Number(offset) } : {}),
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

  const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

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
            className={selectClass}
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

      {/* The selected backend's own optional parameters. */}
      <details className="rounded-md border border-border px-3 py-2" open={false}>
        <summary className="cursor-pointer text-sm font-medium text-foreground">{labels.options}</summary>
        <div className="grid gap-2 pt-2 sm:grid-cols-2">
          {kind === "searxng" && (
            <>
              <Input label={labels.language} placeholder="zh-CN" value={language} onChange={(e) => setLanguage(e.target.value)} />
              <div>
                <label htmlFor="searx-safesearch" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.safesearch}
                </label>
                <select id="searx-safesearch" value={safesearch} onChange={(e) => setSafesearch(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </div>
              <div>
                <label htmlFor="searx-time" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.timeRange}
                </label>
                <select id="searx-time" value={timeRange} onChange={(e) => setTimeRange(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                  <option value="year">year</option>
                </select>
              </div>
              <Input label={labels.categories} placeholder="general,news" value={categories} onChange={(e) => setCategories(e.target.value)} />
              <Input label={labels.pageno} type="number" min={1} max={20} value={pageno} onChange={(e) => setPageno(e.target.value)} />
            </>
          )}

          {kind === "tavily" && (
            <>
              <div>
                <label htmlFor="tavily-depth" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.searchDepth}
                </label>
                <select id="tavily-depth" value={searchDepth} onChange={(e) => setSearchDepth(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="basic">basic</option>
                  <option value="advanced">advanced</option>
                </select>
              </div>
              <div>
                <label htmlFor="tavily-topic" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.topic}
                </label>
                <select id="tavily-topic" value={topic} onChange={(e) => setTopic(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="general">general</option>
                  <option value="news">news</option>
                  <option value="finance">finance</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={includeAnswer} onChange={(e) => setIncludeAnswer(e.target.checked)} className="h-4 w-4 accent-primary" />
                {labels.includeAnswer}
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={includeRawContent} onChange={(e) => setIncludeRawContent(e.target.checked)} className="h-4 w-4 accent-primary" />
                {labels.includeRawContent}
              </label>
              <Input label={labels.days} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
              <Input label={labels.country} placeholder="china" value={country} onChange={(e) => setCountry(e.target.value)} />
            </>
          )}

          {kind === "brave" && (
            <>
              <Input label={labels.country} placeholder="CN" value={country} onChange={(e) => setCountry(e.target.value)} />
              <Input label={labels.language} placeholder="zh-hans" value={language} onChange={(e) => setLanguage(e.target.value)} />
              <div>
                <label htmlFor="brave-safesearch" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.safesearch}
                </label>
                <select id="brave-safesearch" value={safesearch} onChange={(e) => setSafesearch(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="off">off</option>
                  <option value="moderate">moderate</option>
                  <option value="strict">strict</option>
                </select>
              </div>
              <div>
                <label htmlFor="brave-freshness" className="mb-1.5 block text-sm font-medium text-foreground">
                  {labels.freshness}
                </label>
                <select id="brave-freshness" value={freshness} onChange={(e) => setFreshness(e.target.value)} className={selectClass}>
                  <option value="">—</option>
                  <option value="pd">pd (24h)</option>
                  <option value="pw">pw (7d)</option>
                  <option value="pm">pm (31d)</option>
                  <option value="py">py (1y)</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={extraSnippets} onChange={(e) => setExtraSnippets(e.target.checked)} className="h-4 w-4 accent-primary" />
                {labels.extraSnippets}
              </label>
              <Input label={labels.offset} type="number" min={0} max={9} value={offset} onChange={(e) => setOffset(e.target.value)} />
            </>
          )}

          {kind === "openai-compatible" && (
            <p className="text-xs text-muted-foreground sm:col-span-2">—</p>
          )}
        </div>
      </details>

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
