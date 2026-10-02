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
import { CredentialPanel, type Mode } from "@/lib/assistant/CredentialPanel";

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
  const abortRef = useRef<AbortController | null>(null);

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
    setBusy(true);
    setError(null);
    setAnswer("");
    setLatency(null);
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
          body: JSON.stringify({ model, prompt }),
          signal: controller.signal,
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { answer?: string; latencyMs?: number; totalTokens?: number | null };
          error?: { message?: string };
        } | null;
        if (!res.ok || !json?.ok) {
          setError(json?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        setAnswer(json.data?.answer ?? "");
        setLatency(json.data?.latencyMs ?? Date.now() - started);
        return;
      }

      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${relayKey.trim()}`,
        },
        body: JSON.stringify({
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
        <Input
          label={labels.keyLabel}
          hint={labels.keyHint}
          type="password"
          autoComplete="off"
          placeholder={labels.keyPlaceholder}
          value={relayKey}
          onChange={(e) => setRelayKey(e.target.value)}
        />

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

        <CredentialPanel
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
