"use client";

/**
 * app/(user)/dashboard/models/ModelTester.tsx
 *
 * Stream a real request at a model this gateway serves, using the caller's own
 * `sk-relay-…` key.
 *
 * The key is component state and nothing else: it is not stored, not put in
 * the URL, and re-sent with each request. That is what lets the same page work
 * without asking the server to hold a second copy of a credential the user
 * already gave us.
 *
 * The request goes straight to the gateway's own public URL rather than through
 * a server route, so what is being tested is exactly what a client would see —
 * including a buffering mistake in the reverse proxy, which a server-side
 * proxy would hide.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CredentialChoice, type Mode } from "@/lib/assistant/CredentialPanel";

interface Labels {
  title: string;
  desc: string;
  keyLabel: string;
  keyHint: string;
  keyPlaceholder: string;
  prompt: string;
  send: string;
  stop: string;
  empty: string;
  needsKey: string;
  parameters: string;
  parametersHint: string;
  extraParameters: string;
  extraParametersHint: string;
  decisionAction: Record<string, string>;
  /** Names the interface whose rule produced the decisions below it. */
  decidedBy: string;
}

interface Props {
  chatModels: string[];
  labels: Labels;
}

export function ModelTester({ chatModels, labels }: Props) {
  const [relayKey, setRelayKey] = useState("");
  const [credentialMode, setCredentialMode] = useState<Mode>("account");
  const [model, setModel] = useState(chatModels[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [extraJson, setExtraJson] = useState("");
  const [extraError, setExtraError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Array<{ name: string; action: string; note?: string }>>([]);
const [governedBy, setGovernedBy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setParam = (key: string, value: string) =>
    setParams((prev) => {
      const next = { ...prev };
      if (value.trim() === "") delete next[key];
      else next[key] = value;
      return next;
    });

  const paramCount = Object.keys(params).length + (extraJson.trim() ? 1 : 0);

  /**
   * Numbers go as numbers.
   *
   * `"temperature": "0.5"` is a string to a vendor, and the most likely
   * response is a 400 that looks like the model is broken. The four fields that
   * are numbers everywhere are coerced; anything in the free-form box is left
   * exactly as typed, because only the sender knows whether it is a number.
   */
  const NUMERIC = new Set(["temperature", "top_p", "max_tokens", "seed"]);
  const buildParameters = (): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } => {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      const trimmed = v.trim();
      value[k] = NUMERIC.has(k) && trimmed !== "" && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
    }
    if (extraJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(extraJson);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "JSON 解析失败" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, message: "必须是一个 JSON 对象" };
      }
      Object.assign(value, parsed as Record<string, unknown>);
    }
    return { ok: true, value };
  };

  const base = useMemo(
    () => (typeof window !== "undefined" ? window.location.origin : ""),
    [],
  );

  const canSend = Boolean(
    model && prompt.trim() && !busy && (credentialMode === "account" || relayKey.trim()),
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }, []);

  async function send() {
    if (!canSend) return;
    const built = buildParameters();
    if (!built.ok) {
      setExtraError(built.message);
      setParamsOpen(true);
      return;
    }
    setExtraError(null);
    setBusy(true);
    setError(null);
    setAnswer("");
    setLatency(null);
    setDecisions([]);
    const started = Date.now();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Account path: the browser holds no token, so the call goes through the
      // server. Key path: the browser calls the public route itself, which is
      // what makes it evidence that the route works.
      if (credentialMode === "account") {
        const res = await fetch("/api/assistant/test-model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt, parameters: built.value }),
          signal: controller.signal,
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: {
            answer?: string;
            latencyMs?: number;
            totalTokens?: number | null;
            parameterDecisions?: Array<{ name: string; action: string; note?: string }>;
            governedBy?: string | null;
          };
          error?: { message?: string };
        } | null;
        if (!res.ok || !json?.ok) {
          setError(json?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        setAnswer(json.data?.answer ?? "");
        setLatency(json.data?.latencyMs ?? Date.now() - started);
        setDecisions(json.data?.parameterDecisions ?? []);
        // Which interface's rule explained the request. A provider carries one
        // rule per interface, and the test goes out through Chat Completions —
        // without this the panel cannot say which rule it is reporting.
        setGovernedBy(json.data?.governedBy ?? null);
        return;
      }

      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey.trim()}`,
        },
        body: JSON.stringify({
          ...built.value,
          model,
          messages: [{ role: "user", content: prompt }],
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setError(`${res.status} ${text.slice(0, 400)}`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            const text = chunk.choices?.[0]?.delta?.content;
            if (text) setAnswer((prev) => prev + text);
          } catch {
            // A keep-alive or partial line is not a failure; the next chunk
            // carries the real payload.
          }
        }
      }
      setLatency(Date.now() - started);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setLatency(Date.now() - started);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title={labels.title} description={labels.desc} />
      <div className="space-y-4">
        {/* The key field used to live here, directly above the model picker.
            It now belongs to CredentialPanel below, which is the one place
            that decides whether a call runs as the account or with a pasted
            key - two key inputs on one card meant one of them was silently
            ignored. */}

        <div className="space-y-1.5">
          <label htmlFor="model-tester-model" className="block text-sm font-medium text-foreground">
            model
          </label>
          <select
            id="model-tester-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {chatModels.length === 0 && <option value="">—</option>}
            {chatModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="model-tester-prompt" className="block text-sm font-medium text-foreground">
            {labels.prompt}
          </label>
          <textarea
            id="model-tester-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="Say PONG"
          />
        </div>

        {/*
          The request parameters, folded away.

          A tester that only sends a prompt answers "is this model up", and
          "does this vendor actually honour `reasoning_effort`" is the question
          an operator with a text spec needs answered. Folded, because the
          common case is one prompt and nothing else.
        */}
        <div className="rounded-md border border-border">
          <button
            type="button"
            onClick={() => setParamsOpen((v) => !v)}
            aria-expanded={paramsOpen}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
          >
            <span className="font-medium text-foreground">{labels.parameters}</span>
            <span className="text-xs text-muted-foreground">
              {paramCount > 0 ? `${paramCount} 项` : ""} {paramsOpen ? "▾" : "▸"}
            </span>
          </button>

          {paramsOpen && (
            <div className="space-y-3 border-t border-border px-3 py-3">
              <p className="text-xs text-muted-foreground">{labels.parametersHint}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  label="reasoning_effort"
                  placeholder="low / medium / high"
                  value={params.reasoning_effort ?? ""}
                  onChange={(e) => setParam("reasoning_effort", e.target.value)}
                />
                <Input
                  label="temperature"
                  placeholder="0 - 2"
                  value={params.temperature ?? ""}
                  onChange={(e) => setParam("temperature", e.target.value)}
                />
                <Input
                  label="top_p"
                  placeholder="0 - 1"
                  value={params.top_p ?? ""}
                  onChange={(e) => setParam("top_p", e.target.value)}
                />
                <Input
                  label="max_tokens"
                  placeholder="200"
                  value={params.max_tokens ?? ""}
                  onChange={(e) => setParam("max_tokens", e.target.value)}
                />
              </div>
              <Input
                label={labels.extraParameters}
                hint={labels.extraParametersHint}
                placeholder='{"seed":42,"thinking":{"type":"enabled","budget_tokens":4000}}'
                value={extraJson}
                onChange={(e) => setExtraJson(e.target.value)}
              />
              {extraError && <p className="text-xs text-destructive">{extraError}</p>}
            </div>
          )}
        </div>

        {/*
          What the operator's protocol did to them. Without this a tester sees
          "I asked for low reasoning and got a different answer" and has no way
          to tell a broken model from a deliberate override.
        */}
        {decisions.length > 0 && (
          <ul className="space-y-0.5 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
            {/* Which interface's rule did this. A provider carries one per
                interface and the test goes out through Chat Completions, so
                without the label these lines belong to nobody. */}
            {governedBy && (
              <li className="text-[10px] opacity-80">
                {labels.decidedBy} <code className="text-foreground">{governedBy}</code>
              </li>
            )}
            {decisions.map((d) => (
              <li key={d.name}>
                <code className="text-foreground">{d.name}</code> · {labels.decisionAction[d.action] ?? d.action}
                {d.note ? ` · ${d.note}` : ""}
              </li>
            ))}
          </ul>
        )}

        <CredentialChoice
          mode={credentialMode}
          onModeChange={setCredentialMode}
          relayKey={relayKey}
          onRelayKeyChange={setRelayKey}
        />

        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={!canSend}>
            {busy ? labels.stop : labels.send}
          </Button>
          {busy && (
            <Button variant="outline" onClick={stop}>
              {labels.stop}
            </Button>
          )}
          {latency !== null && !busy && (
            <span className="text-xs text-muted-foreground">{latency} ms</span>
          )}
        </div>

        {credentialMode === "key" && !relayKey.trim() && (
          <p className="text-xs text-muted-foreground">{labels.needsKey}</p>
        )}
        {error && (
          <pre className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </pre>
        )}

        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{model || "—"}</p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {answer || <span className="text-muted-foreground">{labels.empty}</span>}
          </p>
        </div>
      </div>
    </Card>
  );
}
