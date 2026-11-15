"use client";

/**
 * 其他服务商, media: one guided form per capability, plus the raw escape hatch.
 *
 * The guided form exists because the interesting question is usually "does this
 * vendor's image endpoint work with this key", not "can I write its JSON from
 * memory". The raw panel exists for the vendor whose shape this form does not
 * model. Both show the resolved endpoint before the call, because "which URL did
 * it actually hit" was the thing this page could not answer.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { RawRequestPanel, type RawRequestLabels } from "./RawRequestPanel";

type Capability = "image.generate" | "video.generate" | "audio.tts" | "audio.stt" | "music.generate";

const PATHS: Record<Capability, string> = {
  "image.generate": "/images/generations",
  "video.generate": "/videos",
  "audio.tts": "/audio/speech",
  "audio.stt": "/audio/transcriptions",
  "music.generate": "/music/generations",
};

export interface OtherMediaLabels {
  title: string;
  hint: string;
  capability: string;
  capabilities: Record<Capability, string>;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
  voice: string;
  duration: string;
  n: string;
  audioFile: string;
  endpoint: string;
  run: string;
  running: string;
  ok: string;
  failed: string;
  result: string;
  raw: string;
}

interface Result {
  endpoint: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  contentType?: string;
  json?: unknown;
  text?: string;
  dataUrl?: string;
  error?: string;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

export function OtherMediaProbe({
  labels,
  rawLabels,
}: {
  labels: OtherMediaLabels;
  rawLabels: RawRequestLabels;
}) {
  const [capability, setCapability] = useState<Capability>("image.generate");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [voice, setVoice] = useState("");
  const [duration, setDuration] = useState("");
  const [n, setN] = useState("1");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const endpoint = useMemo(() => {
    const base = baseUrl.trim().replace(/\/+$/, "");
    return base ? `${base}${PATHS[capability]}` : PATHS[capability];
  }, [baseUrl, capability]);

  const isStt = capability === "audio.stt";
  const needsVoice = capability === "audio.tts";
  const needsSize = capability === "image.generate" || capability === "video.generate";
  const canRun =
    !busy &&
    baseUrl.trim() &&
    apiKey.trim() &&
    model.trim() &&
    (isStt ? Boolean(file) : Boolean(prompt.trim()));

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/models/probe-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          model: model.trim(),
          ...(isStt ? {} : { prompt: prompt.trim() }),
          ...(needsSize && size ? { size } : {}),
          ...(needsVoice && voice ? { voice } : {}),
          ...(duration ? { duration: Number(duration) } : {}),
          ...(n ? { n: Number(n) } : {}),
          ...(isStt && file ? { dataUrl: await fileToDataUrl(file) } : {}),
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
      setApiKey("");
    }
  }

  return (
    <div className="space-y-4">
      <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
        {labels.hint}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="other-media-capability" className="mb-1.5 block text-sm font-medium text-foreground">
            {labels.capability}
          </label>
          <select
            id="other-media-capability"
            value={capability}
            onChange={(e) => setCapability(e.target.value as Capability)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          >
            {(Object.keys(labels.capabilities) as Capability[]).map((cap) => (
              <option key={cap} value={cap}>
                {labels.capabilities[cap]}
              </option>
            ))}
          </select>
        </div>
        <Input label={labels.model} placeholder="model-name" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>

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

      <div className="rounded-md border border-border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">{labels.endpoint}</p>
        <code className="break-all text-xs text-foreground">POST {endpoint}</code>
      </div>

      {isStt ? (
        <div className="space-y-1.5">
          <label htmlFor="other-media-file" className="block text-sm font-medium text-foreground">
            {labels.audioFile}
          </label>
          <input
            id="other-media-file"
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <label htmlFor="other-media-prompt" className="block text-sm font-medium text-foreground">
            {labels.prompt}
          </label>
          <textarea
            id="other-media-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Say PONG"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        {needsSize && (
          <Input label={labels.size} placeholder="1024x1024" value={size} onChange={(e) => setSize(e.target.value)} />
        )}
        {needsVoice && (
          <Input label={labels.voice} placeholder="alloy" value={voice} onChange={(e) => setVoice(e.target.value)} />
        )}
        {capability === "video.generate" && (
          <Input
            label={labels.duration}
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
        )}
        {capability === "image.generate" && (
          <Input label={labels.n} type="number" min={1} max={8} value={n} onChange={(e) => setN(e.target.value)} />
        )}
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
              {result.contentType ? ` · ${result.contentType.split(";")[0]}` : ""}
            </span>
          </p>
          <p className="break-all text-xs text-muted-foreground">POST {result.endpoint}</p>
          {result.error && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">{result.error}</pre>
          )}
          {result.text !== undefined && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
              {result.text}
            </pre>
          )}
          {result.json !== undefined && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
              {JSON.stringify(result.json, null, 2)}
            </pre>
          )}
          {result.dataUrl && result.contentType?.startsWith("image/") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={result.dataUrl} alt={labels.result} className="max-h-80 rounded border border-border" />
          )}
          {result.dataUrl && result.contentType?.startsWith("audio/") && (
            <audio controls src={result.dataUrl} className="w-full" />
          )}
          {result.dataUrl && result.contentType?.startsWith("video/") && (
            <video controls src={result.dataUrl} className="max-h-80 w-full rounded border border-border" />
          )}
          {result.dataUrl && !/^(image|audio|video)\//.test(result.contentType ?? "") && (
            <a href={result.dataUrl} download className="text-xs text-primary underline">
              {labels.result}
            </a>
          )}
        </div>
      )}

      {showRaw && <RawRequestPanel labels={rawLabels} />}
    </div>
  );
}
