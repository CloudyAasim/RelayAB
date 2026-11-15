"use client";

/**
 * 其他服务商, text: a complete OpenAI-compatible chat call, from the browser's
 * point of view — endpoint shown, parameters sent, stream read the way a client
 * reads it.
 *
 * The first version of this panel sent a fixed prompt with `stream: false` and
 * no parameters, which answered "is this key valid" and nothing else: a vendor
 * that rejected `temperature` or ignored `reasoning_effort` looked identical to
 * one that accepted them. The endpoint was not shown either, so "it failed"
 * could not be told apart from "it went somewhere else".
 *
 * The key is deliberately not persisted: it lives in this component for the one
 * call, and is cleared when the call finishes.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RawRequestPanel, type RawRequestLabels } from "./RawRequestPanel";

interface Labels {
  title: string;
  desc: string;
  ephemeral: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  path: string;
  endpoint: string;
  parameters: string;
  extraParameters: string;
  stream: string;
  listModels: string;
  testChat: string;
  testing: string;
  ok: string;
  failed: string;
  foundModels: string;
  raw: string;
  /** The two thinking controls, named as the assistant settings name them. */
  reasoning: string;
  reasoningOff: string;
  thinkingMode: string;
  thinkingVendorDefault: string;
  thinkingOn: string;
  thinkingOff: string;
  /** The folded sampling group. */
  sampling: string;
  /** The system prompt field. */
  systemPrompt?: string;
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

const NUMERIC = new Set(["temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "seed"]);

export function CustomModelProbe({
  labels,
  rawLabels,
  embedded = false,
  onFetched,
}: {
  labels: Labels;
  rawLabels: RawRequestLabels;
  /** Rendered inside the test card's tab instead of its own card. */
  embedded?: boolean;
  /** Models the vendor just listed; the text tester offers them too. */
  onFetched?: (models: string[]) => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [system, setSystem] = useState("");
  const [path, setPath] = useState("");
  const [stream, setStream] = useState(true);
  const [effort, setEffort] = useState<"" | "low" | "medium" | "high">("");
  const [thinking, setThinking] = useState<"" | "enabled" | "disabled">("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [extraJson, setExtraJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [answer, setAnswer] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const endpoint = useMemo(() => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    const suffix = path.trim() || "/chat/completions";
    return base ? `${base}${suffix.startsWith("/") ? "" : "/"}${suffix}` : `…${suffix.startsWith("/") ? "" : "/"}${suffix}`;
  }, [baseUrl, path]);

  const setParam = (key: string, value: string) =>
    setParams((prev) => {
      const next = { ...prev };
      if (value.trim() === "") delete next[key];
      else next[key] = value;
      return next;
    });

  function parameters(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const trimmed = value.trim();
      if (trimmed === "") continue;
      out[key] = NUMERIC.has(key) && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
    }
    if (effort) out.reasoning_effort = effort;
    if (thinking) out.thinking = { type: thinking };
    if (extraJson.trim()) {
      try {
        const parsed = JSON.parse(extraJson) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
        Object.assign(out, parsed);
      } catch {
        return null;
      }
    }
    return out;
  }

  async function listModels() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/models/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), mode: "list" }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: ProbeResult; error?: { message?: string } }
        | null;
      if (json?.ok && json.data) {
        setResult(json.data);
        if (json.data.models?.length) {
          onFetched?.(json.data.models);
          if (!model.trim()) setModel(json.data.models[0]);
        }
      } else {
        setResult({ ok: false, httpStatus: 0, latencyMs: 0, error: json?.error?.message ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setResult({ ok: false, httpStatus: 0, latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setApiKey("");
    }
  }

  async function run() {
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim() || !prompt.trim()) return;
    const built = parameters();
    if (built === null) {
      setResult({ ok: false, httpStatus: 0, latencyMs: 0, error: "额外参数必须是 JSON 对象" });
      return;
    }
    setBusy(true);
    setResult(null);
    setAnswer("");
    const started = Date.now();
    try {
      const res = await fetch("/api/models/probe-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          prompt: prompt.trim(),
          ...(system.trim() ? { messages: [{ role: "system", content: system.trim() }, { role: "user", content: prompt.trim() }] } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
          stream,
          parameters: built,
        }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setResult({ ok: false, httpStatus: res.status, latencyMs: Date.now() - started, error: json?.error?.message ?? `HTTP ${res.status}` });
        return;
      }

      if (!stream) {
        const json = (await res.json()) as { data?: ProbeResult };
        const data = json.data;
        if (!data) {
          setResult({ ok: false, httpStatus: 0, latencyMs: Date.now() - started, error: "空响应" });
          return;
        }
        setResult(data);
        setAnswer(answerOf(data));
        return;
      }

      if (!res.body) {
        setResult({ ok: false, httpStatus: res.status, latencyMs: Date.now() - started, error: "上游没有返回流" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf("\n");
        while (at !== -1) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              setAnswer(text);
            }
          } catch {
            /* keep-alive or partial line */
          }
        }
      }
      setResult({ ok: true, httpStatus: res.status, latencyMs: Date.now() - started, answer: text });
    } catch (err) {
      setResult({ ok: false, httpStatus: 0, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setApiKey("");
    }
  }

  function answerOf(data: ProbeResult): string {
    if (data.answer) return data.answer;
    const json = data as unknown as { json?: { choices?: Array<{ message?: { content?: string } }> } };
    return json.json?.choices?.[0]?.message?.content ?? "";
  }

  const content = (
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
      <Input label={labels.model} placeholder="model-name" value={model} onChange={(e) => setModel(e.target.value)} />

      <div className="rounded-md border border-border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">{labels.endpoint}</p>
        <code className="break-all text-xs text-foreground">POST {endpoint}</code>
      </div>

      {labels.systemPrompt && (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-foreground">{labels.systemPrompt}</summary>
          <textarea
            rows={3}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder="You are a helpful assistant."
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </details>
      )}

      <div className="space-y-1.5">
        <label htmlFor="custom-probe-prompt" className="block text-sm font-medium text-foreground">
          {labels.prompt}
        </label>
        <textarea
          id="custom-probe-prompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Say PONG"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      {/* 思考等级 / 思考开关 first: they are what this tester exists to verify. */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="probe-reasoning" className="mb-1.5 block text-sm font-medium text-foreground">
            {labels.reasoning}
          </label>
          <select
            id="probe-reasoning"
            value={effort}
            onChange={(e) => setEffort(e.target.value as typeof effort)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{labels.reasoningOff}</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
        <div>
          <label htmlFor="probe-thinking" className="mb-1.5 block text-sm font-medium text-foreground">
            {labels.thinkingMode}
          </label>
          <select
            id="probe-thinking"
            value={thinking}
            onChange={(e) => setThinking(e.target.value as typeof thinking)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">{labels.thinkingVendorDefault}</option>
            <option value="enabled">{labels.thinkingOn}</option>
            <option value="disabled">{labels.thinkingOff}</option>
          </select>
        </div>
      </div>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{labels.sampling}</summary>
        <div className="grid gap-2 pt-2 sm:grid-cols-2">
          <Input label="temperature" placeholder="0 - 2" value={params.temperature ?? ""} onChange={(e) => setParam("temperature", e.target.value)} />
          <Input label="top_p" placeholder="0 - 1" value={params.top_p ?? ""} onChange={(e) => setParam("top_p", e.target.value)} />
          <Input label="max_tokens" placeholder="256" value={params.max_tokens ?? ""} onChange={(e) => setParam("max_tokens", e.target.value)} />
          <Input
            label="presence_penalty"
            placeholder="-2 - 2"
            value={params.presence_penalty ?? ""}
            onChange={(e) => setParam("presence_penalty", e.target.value)}
          />
          <Input
            label="frequency_penalty"
            placeholder="-2 - 2"
            value={params.frequency_penalty ?? ""}
            onChange={(e) => setParam("frequency_penalty", e.target.value)}
          />
          <Input label="seed" placeholder="42" value={params.seed ?? ""} onChange={(e) => setParam("seed", e.target.value)} />
          <Input label="stop" placeholder='["\\n"]' value={params.stop ?? ""} onChange={(e) => setParam("stop", e.target.value)} />
        </div>
        <Input
          label={labels.extraParameters}
          placeholder='{"response_format":{"type":"json_object"}}'
          value={extraJson}
          onChange={(e) => setExtraJson(e.target.value)}
        />
      </details>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{labels.parameters}</summary>
        <div className="space-y-2 pt-2">
          <Input
            label={labels.path}
            placeholder="/chat/completions"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={stream}
              onChange={(e) => setStream(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            {labels.stream}
          </label>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" type="button" onClick={listModels} disabled={busy || !baseUrl.trim() || !apiKey.trim()}>
          {labels.listModels}
        </Button>
        <Button
          type="button"
          onClick={run}
          disabled={busy || !baseUrl.trim() || !apiKey.trim() || !model.trim() || !prompt.trim()}
        >
          {busy ? labels.testing : labels.testChat}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
          {labels.raw} {showRaw ? "▾" : "▸"}
        </Button>
      </div>

      {(result || answer) && (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
          {result && (
            <p className="font-medium">
              {result.ok ? labels.ok : labels.failed}
              <span className="ml-2 text-xs text-muted-foreground">
                HTTP {result.httpStatus} · {result.latencyMs} ms
                {result.totalTokens ? ` · ${result.totalTokens} tokens` : ""}
                {result.finishReason ? ` · ${result.finishReason}` : ""}
              </span>
            </p>
          )}
          {result?.error && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">{result.error}</pre>
          )}
          {result?.response && !result.answer && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">{result.response}</pre>
          )}
          {result?.models && result.models.length > 0 && (
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
          {answer && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-sm">
              {answer}
            </pre>
          )}
        </div>
      )}

      {showRaw && <RawRequestPanel labels={rawLabels} />}
    </div>
  );

  if (embedded) return content;
  return <div className="space-y-4">{content}</div>;
}
