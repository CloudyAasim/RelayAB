"use client";

/**
 * The escape hatch: send exactly what the vendor's documentation says.
 *
 * Used by the media and search tabs' 其他服务商 section, next to the guided
 * forms. A field we did not model is one JSON edit away instead of one release
 * away.
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export interface RawRequestLabels {
  title: string;
  hint: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  send: string;
  sending: string;
  status: string;
  response: string;
  failed: string;
}

interface Result {
  status: number;
  ok: boolean;
  latencyMs: number;
  contentType: string;
  text?: string;
  error?: string;
}

export function RawRequestPanel({ labels }: { labels: RawRequestLabels }) {
  const [method, setMethod] = useState("POST");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    setHeadersError(null);
    let parsedHeaders: Record<string, string> = {};
    if (headers.trim()) {
      try {
        const parsed = JSON.parse(headers) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setHeadersError("请求头必须是 JSON 对象");
          return;
        }
        parsedHeaders = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      } catch {
        setHeadersError("请求头不是合法 JSON");
        return;
      }
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/models/probe-raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, url: url.trim(), headers: parsedHeaders, body }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: Result; error?: { message?: string } }
        | null;
      if (!json?.ok || !json.data) {
        setResult({ status: 0, ok: false, latencyMs: 0, contentType: "", error: json?.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      setResult(json.data);
    } catch (err) {
      setResult({ status: 0, ok: false, latencyMs: 0, contentType: "", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-medium text-foreground">{labels.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{labels.hint}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-[7rem_1fr]">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-foreground" htmlFor="raw-method">
            {labels.method}
          </label>
          <select
            id="raw-method"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <Input
          label={labels.url}
          placeholder="https://api.example.com/v1/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="raw-headers" className="block text-sm font-medium text-foreground">
          {labels.headers}
        </label>
        <textarea
          id="raw-headers"
          rows={2}
          spellCheck={false}
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          placeholder={'{"Authorization":"Bearer sk-...","Content-Type":"application/json"}'}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        />
        {headersError && <p className="text-xs text-destructive">{headersError}</p>}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="raw-body" className="block text-sm font-medium text-foreground">
          {labels.body}
        </label>
        <textarea
          id="raw-body"
          rows={5}
          spellCheck={false}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'{\n  "model": "…",\n  "input": "…"\n}'}
          className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
        />
      </div>

      <Button type="button" onClick={send} disabled={busy || !url.trim()}>
        {busy ? labels.sending : labels.send}
      </Button>

      {result && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <p className="font-medium">
            {result.ok ? labels.status : labels.failed}
            <span className="ml-2 text-xs text-muted-foreground">
              HTTP {result.status} · {result.latencyMs} ms
              {result.contentType ? ` · ${result.contentType.split(";")[0]}` : ""}
            </span>
          </p>
          {result.error && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">{result.error}</pre>
          )}
          {result.text !== undefined && result.text !== "" && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
              {result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
