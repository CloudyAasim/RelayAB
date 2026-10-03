"use client";

/**
 * src/app/(user)/dashboard/assistant/VoiceFileButton.tsx
 *
 * Dictate by handing it an audio file.
 *
 * There was a microphone here first, and it went. It needed a permission prompt
 * the browser remembers, and the page could not tell a refusal from a block
 * from a device another program was holding — so it either said nothing when
 * something was wrong, or said something confidently wrong. The transcription
 * endpoint does not care where the audio came from, and a file sidesteps every
 * one of those problems: no permission, no device, no question about what the
 * browser will remember.
 *
 * The file goes to the same OpenAI-compatible `/v1/audio/transcriptions`, by
 * way of `/api/assistant/transcribe` so the browser never sees a key, and the
 * operator configures an `audio.stt` spec once on a media provider. The text
 * lands in the input box rather than as an attachment: dictation is a way of
 * typing, and a transcript the operator has to send as a second message is
 * two messages.
 *
 * The audio itself is not kept and not offered back. Nothing is written to
 * disk, and there is no playback control, because the recording was never a
 * message.
 */
import { useRef, useState } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";

/** Matches what the transcriptions route will accept, and nothing larger. */
const MAX_BYTES = 25 * 1024 * 1024;

export function VoiceFileButton({
  onTranscribed,
  onError,
  disabled,
}: {
  onTranscribed: (text: string) => void;
  onError: (message: string | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function handle(file: File) {
    if (file.size > MAX_BYTES) {
      onError(t("assistant.voice.tooLarge", { mb: Math.round(MAX_BYTES / 1024 / 1024) }));
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
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
      setBusy(false);
    }
  }

  const label = busy ? t("assistant.voice.working") : t("assistant.voice.pickFile");

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.wav,.ogg,.webm,.flac"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file twice in a row still fires.
          e.target.value = "";
          if (file) void handle(file);
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        title={label}
        aria-label={label}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : (
          <AudioLines className="h-4 w-4" aria-hidden />
        )}
      </Button>
    </>
  );
}
