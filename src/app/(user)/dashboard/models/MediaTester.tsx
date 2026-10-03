"use client";

/**
 * src/app/(user)/dashboard/models/MediaTester.tsx
 *
 * Exercise the media models this deployment serves, with the caller's own
 * gateway key, over the same routes a client would use.
 *
 * The four capabilities are genuinely different requests, so they get four
 * forms rather than one generic one:
 *
 *   image.generate   POST /v1/images/generations   JSON, returns urls or b64
 *   video.generate   POST /v1/videos/generations   JSON, returns a task id
 *   audio.tts        POST /v1/audio/speech         JSON, returns audio bytes
 *   audio.stt        POST /v1/audio/transcriptions multipart, returns text
 *
 * A model that is disabled upstream, or missing a spec, is still selectable
 * here: the point of the page is to find out what happens, so a 404 with a
 * readable reason beats a model that silently does not appear.
 */
import { useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { CredentialChoice, type Mode } from "@/lib/assistant/CredentialPanel";

export interface MediaModelOption {
  id: string;
  capability: string;
  provider: string;
}

interface Labels {
  title: string;
  desc: string;
  keyLabel: string;
  keyHint: string;
  keyPlaceholder: string;
  model: string;
  prompt: string;
  promptPlaceholder: string;
  size: string;
  duration: string;
  durationHint: string;
  ratio: string;
  voice: string;
  voiceHint: string;
  language: string;
  audioFile: string;
  run: string;
  running: string;
  needsKey: string;
  needsPrompt: string;
  needsFile: string;
  imageResult: string;
  audioResult: string;
  videoResult: string;
  textResult: string;
  failed: string;
  empty: string;
  unsupported: string;
}

interface Props {
  models: MediaModelOption[];
  labels: Labels;
}

type Outcome =
  | { kind: "image"; urls: string[]; b64: number; ms: number }
  | { kind: "audio"; url: string; contentType: string; ms: number }
  | { kind: "video"; payload: unknown; ms: number }
  | { kind: "text"; text: string; ms: number }
  | { kind: "error"; status: number; body: string; ms: number };

const CAP_LABEL: Record<string, string> = {
  "image.generate": "image.generate",
  "video.generate": "video.generate",
  "audio.tts": "audio.tts",
  "audio.stt": "audio.stt",
  "music.generate": "music.generate",
};

/**
 * MiniMax's `t2a_v2` rejects a request with no `voice_setting.voice_id`, so the
 * field is optional in the spec (`$ifPresent`) and the failure only shows up as
 * an upstream 400 phrased as `missing required parameter`. Pre-filling a voice
 * that is known to work turns that into the default path instead of a trap.
 */
const DEFAULT_TTS_VOICE = "English_Trustworth_Man";

/**
 * Video defaults the form must supply.
 *
 * `minimax-hailuo-02` (V1) accepts only 6s and 10s; `minimax-h3` (V2) needs
 * `duration` *and* an explicit `ratio` — it rejects an omitted or "adaptive"
 * one. A duration in both models' accepted set keeps the default usable
 * whichever spec answers.
 */
const DEFAULT_VIDEO_DURATION = 6;
const VIDEO_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] as const;
const DEFAULT_VIDEO_RATIO = "16:9";

function extractItems(body: unknown): { urls: string[]; b64: number } {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { urls: [], b64: 0 };
  const urls: string[] = [];
  let b64 = 0;
  for (const row of data as Array<Record<string, unknown>>) {
    if (typeof row?.url === "string") urls.push(row.url);
    else if (typeof row?.b64_json === "string") b64 += 1;
  }
  return { urls, b64 };
}

export function MediaTester({ models, labels }: Props) {
  const [relayKey, setRelayKey] = useState("");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [voice, setVoice] = useState(DEFAULT_TTS_VOICE);
  const [duration, setDuration] = useState(String(DEFAULT_VIDEO_DURATION));
  const [ratio, setRatio] = useState<string>(DEFAULT_VIDEO_RATIO);
  const [language, setLanguage] = useState("");
  const [credentialMode, setCredentialMode] = useState<Mode>("account");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const current = useMemo(() => models.find((m) => m.id === model), [models, model]);
  const capability = current?.capability ?? "";

  const base = typeof window !== "undefined" ? window.location.origin : "";
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${relayKey.trim()}` };

  async function run() {
    if (!model || busy) return;
    if (credentialMode !== "account" && !relayKey.trim()) return;
    if (capability !== "audio.stt" && !prompt.trim()) return;
    if (capability === "audio.stt" && !file) return;

    setBusy(true);
    setOutcome(null);
    const started = Date.now();

    try {
      let res: Response;
      if (credentialMode === "account") {
        // No bearer token exists on this path, so the call goes through the
        // server. Speech recognition is the one capability that carries a file,
        // and the route takes multipart for it — the same shape the public
        // endpoint takes — so every capability can spend the account.
        if (isStt && file) {
          const form = new FormData();
          form.append("model", model);
          form.append("file", file);
          if (language) form.append("language", language);
          res = await fetch("/api/assistant/test-media", { method: "POST", body: form });
        } else {
          res = await fetch("/api/assistant/test-media", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              capability,
              model,
              prompt,
              ...(size ? { size } : {}),
              ...(capability === "video.generate"
                ? {
                    duration: Number(duration) || DEFAULT_VIDEO_DURATION,
                    ...(ratio ? { ratio } : {}),
                  }
                : {}),
              ...(voice ? { voice } : {}),
            }),
          });
        }
      } else if (capability === "image.generate") {
        res = await fetch(`${base}/v1/images/generations`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ model, prompt, n: 1, size }),
        });
      } else if (capability === "video.generate") {
        // Both video specs require `duration`, and MiniMax's H3 additionally
        // refuses an omitted/adaptive `ratio` with a bare field-path error.
        // Sending neither means the form's first click is always a 400 about a
        // field the user cannot see.
        res = await fetch(`${base}/v1/videos/generations`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            duration: Number(duration) || DEFAULT_VIDEO_DURATION,
            ...(ratio ? { ratio } : {}),
          }),
        });
      } else if (capability === "audio.tts") {
        res = await fetch(`${base}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${relayKey.trim()}` },
          body: JSON.stringify({ model, input: prompt, response_format: "mp3", ...(voice ? { voice } : {}) }),
        });
      } else {
        const form = new FormData();
        form.append("model", model);
        if (file) form.append("file", file);
        if (language) form.append("language", language);
        res = await fetch(`${base}/v1/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${relayKey.trim()}` },
          body: form,
        });
      }

      const ms = Date.now() - started;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setOutcome({ kind: "error", status: res.status, body: text.slice(0, 1200), ms });
        return;
      }

      if (capability === "audio.tts") {
        // The endpoint answers with bytes, so hand them straight to an <audio>
        // via an object URL rather than trying to JSON-parse them.
        const blob = await res.blob();
        setOutcome({
          kind: "audio",
          url: URL.createObjectURL(blob),
          contentType: blob.type || res.headers.get("content-type") || "audio/mpeg",
          ms,
        });
        return;
      }

      const json: unknown = await res.json().catch(() => null);

      if (capability === "image.generate") {
        setOutcome({ kind: "image", ...extractItems(json), ms });
      } else if (capability === "audio.stt") {
        setOutcome({
          kind: "text",
          text: String((json as { text?: unknown })?.text ?? JSON.stringify(json)),
          ms,
        });
      } else {
        setOutcome({ kind: "video", payload: json, ms });
      }
    } catch (err) {
      setOutcome({
        kind: "error",
        status: 0,
        body: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      });
    } finally {
      setBusy(false);
    }
  }

  const isStt = capability === "audio.stt";
  const hasCredential = credentialMode === "account" || Boolean(relayKey.trim());
  const canRun = Boolean(model) && hasCredential && !busy && (isStt ? Boolean(file) : Boolean(prompt.trim()));

  return (
    <Card>
      <CardHeader title={labels.title} description={labels.desc} />
      <div className="space-y-4">
        {/* Same reason as on the chat tester: the key belongs to the panel that
            decides which credential a call spends, and this card was showing a
            second one that the account path would quietly ignore. */}
        <CredentialChoice
          mode={credentialMode}
          onModeChange={setCredentialMode}
          relayKey={relayKey}
          onRelayKeyChange={setRelayKey}
        />

        <div className="space-y-1.5">
          <label htmlFor="media-model" className="block text-sm font-medium text-foreground">
            {labels.model}
          </label>
          {/* Closed, like the chat tester's. See the note in ModelTester: the
              datalist version let a model be typed that this list has no
              capability for, and the tester has nothing to send it to. */}
          <select
            id="media-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {models.length === 0 && <option value="">—</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · {CAP_LABEL[m.capability] ?? m.capability}
              </option>
            ))}
          </select>
          {current && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Badge tone="purple">{CAP_LABEL[current.capability] ?? current.capability}</Badge>
              <span>{current.provider}</span>
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="media-prompt" className="block text-sm font-medium text-foreground">
            {isStt ? labels.audioFile : labels.prompt}
          </label>
          {isStt ? (
            <input
              id="media-prompt"
              type="file"
              accept="audio/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              /* Bordered like every other field here. The bare native control
                 next to bordered inputs read as a component that had lost its
                 box rather than as a file picker. */
              className="block w-full cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
          ) : (
            <textarea
              id="media-prompt"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={labels.promptPlaceholder}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {capability === "image.generate" && (
            <Input
              label={labels.size}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="1024x1024"
            />
          )}
          {capability === "video.generate" && (
            <Input
              label={labels.duration}
              hint={labels.durationHint}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          )}
          {capability === "video.generate" && (
            <div className="space-y-1.5">
              <label htmlFor="media-ratio" className="block text-sm font-medium text-foreground">
                {labels.ratio}
              </label>
              <select
                id="media-ratio"
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {VIDEO_RATIOS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          )}
          {capability === "audio.tts" && (
            <Input
              label={labels.voice}
              hint={labels.voiceHint}
              required
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
            />
          )}
          {isStt && (
            /* Language only ever renders for speech recognition, where it is
               the grid's only child - so spanning the row is what a lone field
               filling half a card always looked like a mistake. */
            <div className="sm:col-span-2">
              <Input
                label={labels.language}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="zh"
              />
            </div>
          )}
        </div>

        {/* The button and its reasons were on one line, so two hints and a
            button ended up shoulder to shoulder reading as one run-on line.
            The reasons belong under the button. */}
        <div className="space-y-2">
          <div>
            <Button onClick={run} disabled={!canRun}>
              {busy ? labels.running : labels.run}
            </Button>
          </div>
          {credentialMode === "key" && !relayKey.trim() && (
            <p className="text-xs text-muted-foreground">{labels.needsKey}</p>
          )}
          {capability && !isStt && !prompt.trim() && (
            <p className="text-xs text-muted-foreground">{labels.needsPrompt}</p>
          )}
          {isStt && !file && <p className="text-xs text-muted-foreground">{labels.needsFile}</p>}
        </div>

        {outcome && (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
            <p className="text-xs text-muted-foreground">
              {outcome.kind === "error" ? labels.failed : ""} {outcome.ms} ms
            </p>

            {outcome.kind === "error" && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-destructive">
                {outcome.status ? `HTTP ${outcome.status}\n` : ""}
                {outcome.body}
              </pre>
            )}

            {outcome.kind === "image" && (
              <>
                {outcome.urls.length > 0 ? (
                  <div className="space-y-2">
                    {outcome.urls.map((u) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={u} src={u} alt={labels.imageResult} className="max-h-80 rounded-md" />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {outcome.b64 > 0 ? `${outcome.b64} 张 base64 图片` : labels.empty}
                  </p>
                )}
              </>
            )}

            {outcome.kind === "audio" && (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio controls src={outcome.url} className="w-full" />
            )}

            {outcome.kind === "text" && (
              <p className="whitespace-pre-wrap break-words">{outcome.text || labels.empty}</p>
            )}

            {outcome.kind === "video" && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(outcome.payload, null, 2)?.slice(0, 2000) ?? labels.empty}
              </pre>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
