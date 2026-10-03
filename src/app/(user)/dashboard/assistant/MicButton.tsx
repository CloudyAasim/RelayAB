"use client";

/**
 * src/app/(user)/dashboard/assistant/MicButton.tsx
 *
 * Dictate into the assistant's input box.
 *
 * Goes through this deployment's own OpenAI-compatible
 * `/v1/audio/transcriptions`, by way of `/api/assistant/transcribe` so the
 * browser never sees a key. The operator configures an `audio.stt` spec once on
 * a media provider and that is the whole setup — there is no second ASR to
 * configure, and no browser speech service that would transcribe somebody's
 * audio somewhere else.
 *
 * The recording stays in the page. `MediaRecorder` hands back a blob, the blob
 * is posted and then dropped; nothing is written to disk and no playback
 * control is offered, because the audio is a means of typing, not a message.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";

type Phase = "idle" | "recording" | "transcribing";

/** `getUserMedia` needs a secure context; localhost counts. */
function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

export function MicButton({
  onTranscribed,
  onError,
  disabled,
}: {
  onTranscribed: (text: string) => void;
  onError: (message: string | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("idle");
  const [supported, setSupported] = useState(true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Stopped by unmount or by switching threads: a recorder left running would
  // keep the microphone indicator on long after the conversation is gone.
  const liveRef = useRef(false);

  useEffect(() => {
    setSupported(recordingSupported());
    return () => {
      liveRef.current = false;
      recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
      recorderRef.current = null;
    };
  }, []);

  const send = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      try {
        const form = new FormData();
        form.append("file", blob, "recording.webm");
        const res = await fetch("/api/assistant/transcribe", { method: "POST", body: form });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; data?: { text?: string }; error?: { code?: string; message?: string } }
          | null;
        if (!res.ok || !json?.ok) {
          onError(
            json?.error?.message ??
              apiErrorMessage(t, json?.error?.code, t("assistant.voice.failed")),
          );
          return;
        }
        const text = (json.data?.text ?? "").trim();
        if (text) onTranscribed(text);
        else onError(t("assistant.voice.empty"));
      } catch (e) {
        onError(e instanceof Error ? e.message : t("assistant.voice.failed"));
      } finally {
        setPhase("idle");
      }
    },
    [onError, onTranscribed, t],
  );

  const start = useCallback(async () => {
    onError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // A refused permission is the common case and has a different remedy from
      // a missing device, so it says which.
      onError(t("assistant.voice.denied"));
      return;
    }
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    liveRef.current = true;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      recorderRef.current = null;
      if (blob.size > 0) void send(blob);
      else setPhase("idle");
    };
    recorder.start();
    setPhase("recording");
  }, [onError, send, t]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else setPhase("idle");
  }, []);

  if (!supported) return null;

  const label =
    phase === "recording"
      ? t("assistant.voice.stop")
      : phase === "transcribing"
        ? t("assistant.voice.working")
        : t("assistant.voice.start");

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      disabled={disabled || phase === "transcribing"}
      onClick={phase === "recording" ? stop : start}
      title={label}
      aria-label={label}
      aria-pressed={phase === "recording"}
      className={phase === "recording" ? "text-destructive hover:text-destructive" : ""}
    >
      {phase === "transcribing" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : phase === "recording" ? (
        <Square className="h-4 w-4" aria-hidden />
      ) : (
        <Mic className="h-4 w-4" aria-hidden />
      )}
    </Button>
  );
}
