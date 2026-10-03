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
 *
 * **Ask, then wait. Do not diagnose.**
 *
 * Two earlier versions asked the Permissions API what the browser thought,
 * split the answer into "refused" and "blocked", and told the operator which
 * one it was. That was a mistake twice over. `getUserMedia` does not settle
 * until somebody answers the prompt, so there is nothing to diagnose while it
 * is outstanding — and the version that did diagnose it told an operator who
 * had just set the microphone to Allow that the browser had remembered a
 * refusal. They were looking at the setting that disproved it.
 *
 * So: raise the request on mount, and if it has not been answered after a
 * while, say so. One message, one remedy, no claim about the browser's memory
 * that cannot be checked from here. The press-to-record path asks again
 * immediately, which is strictly more than the timer offers.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, MicOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";

/**
 * `unsupported` is decided once, from capability, and is the only state here
 * that is not about the prompt. `asking` is the prompt outstanding. `waiting`
 * is the prompt unanswered for a while. `ready` is granted.
 */
type MicState = "unsupported" | "asking" | "waiting" | "ready" | "recording" | "transcribing";

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
 * Why the microphone would not open, in the operator's words.
 *
 * The browser names four failures that need four different responses, and only
 * the first two are about permission. This version of the button threw that
 * away on the press path and answered "press it again" to all of them — which
 * is advice for the one case where repeating might help, and nothing at all
 * for a machine with no microphone in it.
 *
 * Anything unrecognised is reported as the browser's own `name` and `message`
 * rather than as a guess. Guessing is what produced two rounds of confident
 * messages that were wrong on arrival.
 */
function explainFailure(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const name =
    typeof err === "object" && err && "name" in err ? String((err as Error).name) : "";
  const message =
    typeof err === "object" && err && "message" in err ? String((err as Error).message) : "";

  switch (name) {
    case "NotFoundError":
    case "OverconstrainedError":
      return t("assistant.voice.noDevice");
    case "NotAllowedError":
    case "SecurityError":
      return t("assistant.voice.refused");
    case "NotReadableError":
    case "TrackStartError":
      return t("assistant.voice.busy");
    case "AbortError":
      return t("assistant.voice.aborted");
    case "OverconstrainedError":
      return t("assistant.voice.noDevice");
    default:
      // The raw pair, so a report can be acted on rather than guessed about.
      return name || message
        ? t("assistant.voice.unknown", { detail: `${name}${message ? `: ${message}` : ""}` })
        : t("assistant.voice.failed");
  }
}

/**
 * How long an unanswered prompt is waited out before saying anything.
 *
 * Long enough for somebody who is reading the page to find and click the
 * browser's own prompt, which sits in the address-bar area and is easy to miss
 * on a windowed site like this one. Not so long that a person who is not
 * answering is left with a message that outlives their attention.
 */
const ASK_TIMEOUT_MS = 12_000;

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
  const [state, setState] = useState<MicState>("asking");
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stopped by unmount or by switching threads: a recorder left running would
  // keep the microphone indicator on long after the conversation is gone.
  const liveRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /**
   * Raise the request, and start waiting for an answer.
   *
   * The prompt is raised while the assistant screen is open — where the
   * microphone is visible and its purpose obvious. A prompt raised by pressing
   * the button is easy to refuse by reflex, and a refusal is remembered for
   * the site, so the next visit does not prompt at all.
   *
   * The tracks are released the moment they arrive: this asks for permission,
   * it does not record, and a microphone the operator cannot see is worse than
   * none.
   */
  const ask = useCallback(() => {
    if (!recordingSupported()) {
      setState("unsupported");
      return;
    }
    setDeviceError(null);
    setState("asking");
    clearTimer();
    timerRef.current = setTimeout(() => setState("waiting"), ASK_TIMEOUT_MS);

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        clearTimer();
        stream.getTracks().forEach((track) => track.stop());
        setState("ready");
      })
      .catch((err) => {
        clearTimer();
        setDeviceError(explainFailure(err, t));
        setState("waiting");
      });
  }, [clearTimer, t]);

  useEffect(() => {
    ask();
    return () => {
      liveRef.current = false;
      recorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
      recorderRef.current = null;
      clearTimer();
    };
  }, [ask, clearTimer]);

  const send = useCallback(
    async (blob: Blob) => {
      setState("transcribing");
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
        setState("ready");
      }
    },
    [onError, onTranscribed, t],
  );

  const start = useCallback(async () => {
    onError(null);
    setDeviceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      /**
       * The same explanation as the mount path, so a button press and a mount
       * cannot report different reasons for the same failure. This used to
       * answer "press it again" to everything, which is advice for one case and
       * silence for a machine with no microphone in it.
       */
      const reason = explainFailure(err, t);
      setDeviceError(reason);
      // Ask again anyway: pressing the button is an explicit request, and if the
      // cause was transient — something holding the device a moment ago — this
      // is the cheapest way to find out.
      ask();
      return;
    }
    setState("recording");
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
      else setState("ready");
    };
    recorder.start();
  }, [ask, onError, send, t]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else setState("ready");
  }, []);

  if (state === "unsupported") return null;

  const label =
    state === "recording"
      ? t("assistant.voice.stop")
      : state === "transcribing"
        ? t("assistant.voice.working")
        : state === "asking"
          ? t("assistant.voice.asking")
          : state === "waiting"
            ? t("assistant.voice.waiting")
            : t("assistant.voice.start");

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled || state === "transcribing" || state === "asking"}
        onClick={state === "recording" ? stop : start}
        title={label}
        aria-label={label}
        aria-pressed={state === "recording"}
        className={
          state === "recording"
            ? "text-destructive hover:text-destructive"
            : state === "waiting"
              ? "text-muted-foreground/60 hover:text-muted-foreground"
              : ""
        }
      >
        {state === "transcribing" || state === "asking" ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : state === "recording" ? (
          <Square className="h-4 w-4" aria-hidden />
        ) : state === "waiting" ? (
          <MicOff className="h-4 w-4" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </Button>

      {/*
        Said once, after the prompt has been outstanding long enough to be
        missed, and only about what the operator can do about it.
      */}
      {state === "waiting" && !deviceError && (
        <p className="ml-2 max-w-xs text-xs text-muted-foreground">{t("assistant.voice.waitingHint")}</p>
      )}
      {deviceError && <p className="ml-2 text-xs text-destructive">{deviceError}</p>}
    </>
  );
}
