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
 *
 * **Three configurations, one control.** The credential selector used to offer
 * 本账号 and 服务密钥; "其他服务商" was a separate card at the bottom of the page
 * with a second copy of the model/key fields. It is the same question ("what am
 * I testing, and with which credential"), so it is the third option here and the
 * card is gone.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ModelCombobox } from "../assistant/ModelCombobox";
import { CredentialChoice, type Mode } from "@/lib/assistant/CredentialPanel";
import { CustomModelProbe } from "./CustomModelProbe";
import type { RawRequestLabels } from "./RawRequestPanel";

interface Labels {
  title: string;
  desc: string;
  /** The field's own label. The value is the model id. */
  model: string;
  /** The option that reveals a free-text field. */
  modelCustom: string;
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
  /** Label above the resolved request URL. */
  endpoint?: string;
  /** The two thinking controls, named as the assistant settings name them. */
  reasoning: string;
  reasoningOff: string;
  thinkingMode: string;
  thinkingVendorDefault: string;
  thinkingOn: string;
  thinkingOff: string;
  /** The folded sampling group. */
  sampling: string;
  /** What the three configurations are called on this page. */
  config?: { account: string; key: string; other: string };
}

type ProbeLabels = React.ComponentProps<typeof CustomModelProbe>["labels"];

interface Props {
  chatModels: string[];
  labels: Labels;
  /** Labels for the inline 其他服务商 form. */
  otherLabels: ProbeLabels;
  /** Labels for the raw-request escape hatch. */
  rawLabels: RawRequestLabels;
  /** Models a vendor just listed, so the combobox can offer them. */
  onFetched?: (models: string[]) => void;
  /** Rendered inside the test card's tab instead of its own card. */
  embedded?: boolean;
}

type ConfigMode = "account" | "key" | "other";

/**
 * A gateway refusal, in a sentence.
 *
 * Every error the gateway emits is the same JSON envelope, and every one of them
 * carries a `message` written for a person. Showing the envelope instead means
 * the reader has to know the field names to learn what happened — and the case
 * that matters most here is `model_not_allowed`, which is exactly what someone
 * testing a model they cannot reach needs to read.
 */
function readableError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed?.error?.message ?? parsed?.message;
    if (message) return `${status} ${message}`;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return `${status} ${body.slice(0, 400)}`;
}

export function ModelTester({ chatModels, labels, otherLabels, rawLabels, onFetched, embedded = false }: Props) {
  const [relayKey, setRelayKey] = useState("");
  const [configMode, setConfigMode] = useState<ConfigMode>("account");
  const [model, setModel] = useState(chatModels[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [effort, setEffort] = useState<"" | "low" | "medium" | "high">("");
  const [thinking, setThinking] = useState<"" | "enabled" | "disabled">("");
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

  const paramCount =
    Object.keys(params).length + (extraJson.trim() ? 1 : 0) + (effort ? 1 : 0) + (thinking ? 1 : 0);

  /**
   * Numbers go as numbers.
   *
   * `"temperature": "0.5"` is a string to a vendor, and the most likely
   * response is a 400 that looks like the model is broken. The four fields that
   * are numbers everywhere are coerced; anything in the free-form box is left
   * exactly as typed, because only the sender knows whether it is a number.
   */
  const NUMERIC = new Set([
    "temperature",
    "top_p",
    "max_tokens",
    "seed",
    "presence_penalty",
    "frequency_penalty",
  ]);
  const buildParameters = (): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } => {
    const value: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      const trimmed = v.trim();
      value[k] = NUMERIC.has(k) && trimmed !== "" && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
    }
    if (effort) value.reasoning_effort = effort;
    if (thinking) value.thinking = { type: thinking };
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
    model &&
      prompt.trim() &&
      !busy &&
      (configMode === "account" || (configMode === "key" && relayKey.trim())),
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
      if (configMode === "account") {
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
        // A typed model makes `403 model_not_allowed` a reachable outcome, and
        // the raw envelope says it as `{"code":"model_not_allowed",…}` — which
        // is the answer, just not phrased for whoever is reading it.
        const text = await res.text().catch(() => "");
        setError(readableError(res.status, text));
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

  const credentialMode: Mode = configMode === "other" ? "key" : configMode;

  const content = (
    <div className="space-y-4">
      {/*
        Configuration first: it decides where the call goes and who pays for it,
        so it belongs above the model and the prompt — not at the bottom, where
        the reader met it after filling the form.
      */}
      <CredentialChoice
        mode={credentialMode}
        onModeChange={(next) => setConfigMode(next)}
        relayKey={relayKey}
        onRelayKeyChange={setRelayKey}
        modeLabels={labels.config ? { account: labels.config.account, key: labels.config.key } : undefined}
        extraOption={
          labels.config
            ? {
                label: labels.config.other,
                selected: configMode === "other",
                onSelect: () => setConfigMode("other"),
              }
            : undefined
        }
        hideKeyField={configMode === "other"}
        keyFieldLabel={labels.config?.key}
      />

      {configMode === "other" ? (
        <CustomModelProbe embedded labels={otherLabels} rawLabels={rawLabels} onFetched={onFetched} />
      ) : (
        <>
          {labels.endpoint && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <p className="text-xs text-muted-foreground">{labels.endpoint}</p>
              <code className="break-all text-xs text-foreground">
                POST {configMode === "account" ? "/api/assistant/test-model" : `${base}/v1/chat/completions`}
              </code>
            </div>
          )}
          <div className="space-y-1.5">
            <ModelCombobox
              id="model-tester-model"
              label={labels.model}
              customLabel={labels.modelCustom}
              placeholder="model-name"
              value={model}
              options={chatModels}
              onChange={setModel}
            />
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
                {/* 思考等级 / 思考开关 first: they are what this tester exists to
                    verify. Sampling knobs are folded below them. */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <label htmlFor="tester-reasoning" className="mb-1.5 block text-sm font-medium text-foreground">
                      {labels.reasoning}
                    </label>
                    <select
                      id="tester-reasoning"
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
                    <label htmlFor="tester-thinking" className="mb-1.5 block text-sm font-medium text-foreground">
                      {labels.thinkingMode}
                    </label>
                    <select
                      id="tester-thinking"
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
                    <Input
                      label="seed"
                      placeholder="42"
                      value={params.seed ?? ""}
                      onChange={(e) => setParam("seed", e.target.value)}
                    />
                    <Input
                      label="stop"
                      placeholder='["\\n"]'
                      value={params.stop ?? ""}
                      onChange={(e) => setParam("stop", e.target.value)}
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
                </details>
              </div>
            )}
          </div>

          {/*
            What the operator's protocol did to them. Without this a tester sees
            "I asked for low reasoning and got a different answer" and has no way
            to tell a broken model from a deliberate override.
          */}
          {decisions.length > 0 && (
            <ul className="space-y-1 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
              {/* Which interface's rule did this. A provider carries one per
                  interface and the test goes out through Chat Completions, so
                  without the label these lines belong to nobody. */}
              {governedBy && (
                <li className="text-xs opacity-80">
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

          {configMode === "key" && !relayKey.trim() && (
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
        </>
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
