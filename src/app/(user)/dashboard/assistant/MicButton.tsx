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
    window.isSecureContext !== false &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

/**
 * What the browser currently thinks about the microphone.
 *
 * "denied" and "blocked" are the same word to the operator and opposite
 * problems: a single refusal can be asked again, but once a permission is
 * *blocked* the browser will not prompt again at all, and the only way back is
 * the site settings. Telling someone to "allow it in the browser" for the
 * second case is advice that cannot work.
 */
type MicPermission = "unknown" | "granted" | "denied" | "blocked" | "unsupported";

function permissionStateOf(status: PermissionStatus | undefined): MicPermission {
  if (!status) return "unknown";
  return status.state as MicPermission;
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
  const [permission, setPermission] = useState<MicPermission>("unknown");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Stopped by unmount or by switching threads: a recorder left running would
  // keep the microphone indicator on long after the conversation is gone.
  const liveRef = useRef(false);

  useEffect(() => {
    if (!recordingSupported()) {
      setPermission("unsupported");
      return;
    }
    let cancelled = false;

    // The browser's own state, so a hard block is distinguishable from a
    // refusal. Not supported everywhere; the absence is not a failure.
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        setPermission(permissionStateOf(status));
        status.onchange = () => {
          if (!cancelled) setPermission(permissionStateOf(status));
        };
      })
      .catch(() => setPermission("unknown"));

    /**
     * Ask now rather than on the first click.
     *
     * A prompt raised by pressing the microphone button is easy to refuse by
     * reflex, and a refusal is remembered: the next visit does not prompt at
     * all, and the button reports a problem the operator cannot fix from here.
     * Asking while the assistant screen is open — where the microphone is
     * visible and the purpose is obvious — gives the prompt a context, and
     * grants it now means the button just works later.
     */
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Nothing is recorded and nothing is kept: this is a permission check,
        // not a recording. The tracks are released immediately.
        stream.getTracks().forEach((track) => track.stop());
        if (!cancelled) setPermission("granted");
      })
      .catch(() => {
        // Silence here on purpose. The prompt has been raised; the button
        // carries the state, and a banner on mount for something the operator
        // may not even want is worse than silence.
      });

    return () => {
      cancelled = true;
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
    if (!recordingSupported()) {
      onError(t("assistant.voice.unsupportedContext"));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setPermission("denied");
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotFoundError" || name === "OverconstrainedError") {
        onError(t("assistant.voice.noDevice"));
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        // A refusal is remembered for this site. Whether it can be asked again
        // is a different question from whether it was refused, and the answer is
        // only in the permissions API.
        const state = await navigator.permissions
          ?.query({ name: "microphone" as PermissionName })
          .then((s) => s.state as MicPermission)
          .catch(() => "unknown" as MicPermission);
        setPermission(state === "denied" ? "blocked" : "denied");
        onError(
          state === "denied"
            ? t("assistant.voice.blocked")
            : t("assistant.voice.denied"),
        );
      } else {
        onError(t("assistant.voice.failed"));
      }
      return;
    }
    setPermission("granted");
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

  if (permission === "unsupported") return null;

  // A blocked microphone is not a button that does nothing when pressed — it is
  // one that says so before it is pressed, and says where the fix is.
  const blocked = permission === "blocked";
  const label =
    phase === "recording"
      ? t("assistant.voice.stop")
      : phase === "transcribing"
        ? t("assistant.voice.working")
        : blocked
          ? t("assistant.voice.blockedHint")
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
      className={
        phase === "recording"
          ? "text-destructive hover:text-destructive"
          : blocked
            ? "text-muted-foreground/50 hover:text-muted-foreground"
            : ""
      }
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
