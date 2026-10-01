"use client";

/**
 * app/(user)/dashboard/models/CustomModelProbe.tsx
 *
 * Test an arbitrary OpenAI-compatible endpoint with a key the browser supplies
 * for this one call.
 *
 * The key is deliberately **not** persisted. That is the whole contract of
 * `/api/models/probe`: it lets someone check whether a vendor's key works
 * without handing this server a copy to keep. The field is cleared as soon as
 * the request finishes, and there is no "save" path anywhere in this component.
 *
 * The assistant's own settings are the separate case where a key *is* stored
 * (encrypted), because the assistant has to call it again on every later turn.
 */
import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

interface Labels {
  title: string;
  desc: string;
  ephemeral: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  listModels: string;
  testChat: string;
  testing: string;
  ok: string;
  failed: string;
  foundModels: string;
}

interface ProbeResult {
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  models?: string[];
  error?: string;
  response?: string;
  answer?: string;
  finishReason?: string | null;
  totalTokens?: number | null;
}

export function CustomModelProbe({ labels }: { labels: Labels }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  async function run(mode: "list" | "chat") {
    if (!baseUrl.trim() || !apiKey.trim()) return;
    if (mode === "chat" && !model.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/models/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          ...(mode === "chat" ? { model: model.trim() } : {}),
          mode,
        }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; data?: ProbeResult; error?: { message?: string } }
        | null;

      if (json?.ok && json.data) {
        setResult(json.data);
        // Offer the first model when the list came back, so the common flow
        // (paste URL+key, pick a model, try it) is one click shorter.
        if (mode === "list" && json.data.models?.length && !model.trim()) {
          setModel(json.data.models[0]);
        }
      } else {
        setResult({
          ok: false,
          httpStatus: res.status,
          latencyMs: 0,
          error: json?.error?.message ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setResult({
        ok: false,
        httpStatus: 0,
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      // The key has served its purpose; do not leave it sitting in the DOM.
      setApiKey("");
    }
  }

  return (
    <Card>
      <CardHeader title={labels.title} description={labels.desc} />
      <div className="space-y-4">
        <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
          {labels.ephemeral}
        </p>

        <Input
          label={labels.baseUrl}
          placeholder="https://api.example.com/v1"
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
          label={labels.model}
          placeholder="model-name"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => run("list")}
            disabled={busy || !baseUrl.trim() || !apiKey.trim()}
          >
            {labels.listModels}
          </Button>
          <Button
            onClick={() => run("chat")}
            disabled={busy || !baseUrl.trim() || !apiKey.trim() || !model.trim()}
          >
            {busy ? labels.testing : labels.testChat}
          </Button>
        </div>

        {result && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="font-medium">
              {result.ok ? labels.ok : labels.failed}
              <span className="ml-2 text-xs text-muted-foreground">
                HTTP {result.httpStatus} · {result.latencyMs} ms
              </span>
            </p>

            {result.error && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {result.error}
              </pre>
            )}
            {result.response && !result.answer && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {result.response}
              </pre>
            )}
            {result.models && result.models.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  {labels.foundModels} ({result.models.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {result.models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setModel(m)}
                      className="rounded border border-border px-1.5 py-0.5 text-xs hover:bg-accent"
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {result.answer && (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">
                  {result.finishReason ?? ""}
                  {result.totalTokens ? ` · ${result.totalTokens} tokens` : ""}
                </p>
                <p className="whitespace-pre-wrap break-words">{result.answer}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
