"use client";

/**
 * app/(user)/dashboard/assistant/AssistantChat.tsx
 *
 * A chat screen. The shape follows what people already know from every other
 * AI chat product, because a familiar layout is worth more than an
 * "optimised" one:
 *
 *   - One centred reading column. Messages and the composer share it, so the
 *     eye travels down a single line instead of across a full-width layout.
 *   - The composer is a rounded box with the send button inside it, and it
 *     never leaves the screen. The page does not scroll; this list does.
 *   - The gateway key is a *setting*, not part of the conversation, so it
 *     lives in the settings drawer. Having it pinned above the input on every
 *     screen is the single most chat-hostile thing that was there before.
 *   - The empty state offers something to click. A lone line of grey text is
 *     an empty state; a question with four suggestions is a starting point.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/Sheet";
import { useT } from "@/components/i18n/I18nProvider";
import { readPretty, writePretty } from "@/lib/assistant/pretty";
import { latestRead } from "@/lib/assistant/latest-read";
import type { AssistantConfig } from "@/lib/assistant/config";
import { MediaArtifacts, ToolResultCard, AssistantBody } from "./MediaArtifacts";
import type { ArtifactRef } from "@/lib/db/assistant-artifacts";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { Pencil, Trash2, Paperclip, X } from "lucide-react";
import { useId } from "react";

/**
 * The gateway key for this conversation, and nothing else.
 *
 * The mode switch used to live on this component through `CredentialChoice`,
 * which put a *setting* and a *per-turn secret* in one control and gave the
 * setting no storage. Splitting them is what makes both honest: the mode is
 * decided in the settings form and read from the server, and this is only ever
 * a value that exists while the tab does. The section around it is gated on that
 * same saved mode, so neither the field nor its heading survives a path that
 * has no key.
 */
function PerTurnKeyField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const id = `${useId()}-per-turn-key`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {t("assistant.credential.keyLabel")}
      </label>
      <input
        id={id}
        type="password"
        autoComplete="off"
        placeholder="sk-relay-..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
      />
      <p className="text-xs text-muted-foreground">{t("assistant.credential.keyHint")}</p>
    </div>
  );
}

interface Thread {
  id: string;
  title: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  /** Files the user attached, once the server has given them a URL. */
  attachments?: Attachment[];
}

/** A file the user picked: bytes not yet sent, or a reference once they are. */
interface PendingUpload {
  key: string;
  name: string;
  contentType: string;
  size: number;
  /** Object URL for the preview chip; revoked when the chip goes away. */
  previewUrl: string;
}

interface Attachment extends ArtifactRef {
  name: string;
}

/** Matches the route's allowlist, so the picker refuses before the upload does. */
const UPLOADABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "video/mp4",
  "video/webm",
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOADS = 6;

/**
 * File → base64, without blowing the argument limit.
 *
 * `String.fromCharCode(...bytes)` throws on anything megabyte-sized, and a
 * phone photo is megabyte-sized. The chunking is the fix, and the reason is
 * worth remembering the first time a 4 MB screenshot silently fails.
 */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** What a small, useful attachment list looks like. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type EventPayload =
  | { type: "delta"; text?: string }
  | { type: "tool"; toolName?: string; text?: string }
  | { type: "artifact"; artifacts?: ArtifactRef[] }
  | { type: "action"; text?: string; data?: { actionId?: string } }
  | { type: "error"; text?: string }
  | { type: "done"; data?: { pendingActions?: string[]; usage?: unknown } };

interface Props {
  /**
   * The whole configuration, resolved on the server by one rule.
   *
   * It used to arrive as three separate props — "is there a row", "what is the
   * model", "which models exist" — and the client kept the mode and the account
   * model in component state on top. Four copies of one setting, three of them
   * lost on refresh, and the answer depended on whichever copy the request read.
   */
  config: AssistantConfig;
  settingsPanel: React.ReactNode;
  pendingPanel: React.ReactNode | null;
}

export function AssistantChat({
  config,
  settingsPanel,
  pendingPanel,
}: Props) {
  const t = useT();
  const router = useRouter();

  /**
   * Whether replies are rendered or shown raw. Kept in state as well as
   * localStorage so the change is instant; the stored value is what survives a
   * reload.
   */
  const [pretty, setPretty] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  /** Files picked but not yet sent. The preview chips render from here. */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  /** Kept beside the chips so `send` can read the bytes without a second picker. */
  const uploadFilesRef = useRef(new Map<string, File>());
  const [relayKey, setRelayKey] = useState("");
  /**
   * The mode and the account model are **not** state.
   *
   * They were, and that is the bug this replaced: a model chosen in the
   * credential panel was gone on the next refresh, and an empty one was quietly
   * answered with whichever model the server picked first — so the assistant
   * looked configured while nothing about it was saved. Both now come from
   * `config`, which is resolved once, on the server, from the stored row.
   */
  const credentialMode = config.mode;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Media from the turn in flight. Cleared when a turn starts: once the turn is
   * over the same files are readable from the stored tool messages, and showing
   * both would double every picture.
   */
  const [liveArtifacts, setLiveArtifacts] = useState<ArtifactRef[]>([]);
  const [pendingCount, setPendingCount] = useState(0);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);

  // History management. A conversation belongs to the person reading it, so
  // the drawer offers the two things every chat product offers: give it a name
  // you can find later, and get rid of one you never want to see again.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /**
   * The thread this turn created, when it started without one. `threadId` in a
   * closure is the value from the render that began the turn, which is still
   * null on the first message of a conversation, so the settle step needs this.
   */
  const createdThreadRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /**
   * Escape has to mean "cancel" and not "send PATCH". Unmounting the input
   * while it holds focus can deliver a blur on the way out, so the cancel is
   * recorded and the next commit reads it and does nothing.
   */
  const renameCancelledRef = useRef(false);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/assistant/threads", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { data?: { threads?: Thread[] } } | null;
    setThreads(json?.data?.threads ?? []);
  }, []);

  /**
   * Read a thread, discarding a reply that is no longer the newest.
   *
   * Three things can start a read for the same turn, and without the sequence
   * guard the first one to be issued can be the last to land — see
   * `latest-read` for why that reads as a truncated answer rather than as a
   * race.
   */
  const transcriptReadRef = useRef(latestRead());
  const loadThread = useCallback(async (id: string) => {
    const token = transcriptReadRef.current.begin();
    const res = await fetch(`/api/assistant/threads/${id}`, { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { messages?: ChatMessage[] } }
      | null;
    // A read that has been overtaken is not an error, it is just obsolete.
    if (!transcriptReadRef.current.accept(token)) return;
    setMessages(json?.data?.messages ?? []);
  }, []);

  /**
   * Coming back from a locked screen.
   *
   * The stream is a long-lived fetch, and a phone that has been asleep — or a
   * tab the OS decided to freeze — can end it without the page ever seeing an
   * abort. The turn still completes on the server, but the screen is left
   * showing the partial answer it froze on, and the send button stays disabled
   * because this page still believes it is busy. It reads as the assistant
   * having stopped.
   *
   * So on returning to the foreground, if a turn is in flight, take the
   * transcript from the server rather than from the wire. The server's version
   * is the truth; this page's is a guess that a sleep interrupted.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!busy || !threadId) return;
      abortRef.current?.abort();
      setBusy(false);
      void loadThread(threadId);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [busy, threadId, loadThread]);

  const loadPendingCount = useCallback(async () => {
    if (!pendingPanel) return;
    const res = await fetch("/api/assistant/actions?status=pending", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { actions?: unknown[] } }
      | null;
    setPendingCount(json?.data?.actions?.length ?? 0);
  }, [pendingPanel]);

  useEffect(() => {
    // Read after mount, not during render: the server cannot see localStorage,
    // and rendering one way then switching would flash the wrong form.
    setPretty(readPretty());
  }, []);

  useEffect(() => {
    void loadThreads();
    void loadPendingCount();
  }, [loadThreads, loadPendingCount]);

  /**
   * Load a thread's messages — but never while a turn is in flight.
   *
   * A new conversation has no thread id until the response headers arrive, and
   * the moment one is set this used to load it: mid-stream, with the server
   * holding only the user's message. That overwrote the local transcript, and
   * every later delta then looked for a streaming placeholder that no longer
   * existed, so the answer never appeared at all — only after a reload, which
   * by then could read a complete conversation. It only ever happened on the
   * first message of a conversation, because after that the id is already set
   * and this effect does not re-run.
   */
  useEffect(() => {
    if (busy) return;
    if (threadId) void loadThread(threadId);
    else setMessages([]);
  }, [threadId, busy, loadThread]);

  /**
   * Follow the tail as tokens arrive, but only when the reader is already at it.
   *
   * The position has to be recorded **before** the new content lands. The
   * previous version measured it inside the same effect that was about to grow
   * the element: `scrollHeight - scrollTop - clientHeight < 160`. For a reply
   * shorter than the viewport that is true and it scrolls; the moment a reply is
   * taller than the viewport the distance is already past the threshold, so the
   * condition is false and the view stops following — permanently, for the rest
   * of that reply and every one after it, because the list is now further from
   * the bottom than 160px. Small replies scrolled, long ones did not, which is
   * what made it look intermittent.
   *
   * So the reader's position is tracked on the element's own scroll event — a
   * drag or a keyboard scroll counts, not just the ones React caused — and the
   * growth effect trusts that instead of re-measuring.
   *
   * The scroll is deferred a frame: at effect time the DOM holds the new nodes
   * but may not have laid them out, and `scrollHeight` of an unlaid-out element
   * is the old one.
   */
  const stickToBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // As tokens arrive, follow the tail — but only while the reader is at it.
  useEffect(() => {
    if (!stickToBottom.current) return;
    return scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    // Landing on the assistant page with a thread already loaded: the transcript
    // was fetched before this element existed, so the growth effect never saw it
    // change. Show the newest message, not the oldest.
    stickToBottom.current = true;
    return scrollToBottom();
    // Once, on mount. Re-running it on every message would yank the reader back
    // down mid-scroll, which is the bug the flag above exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "New chat" is a client-side state change; the server creates the thread
   * with the first message (the chat route already does this when no threadId
   * is sent). Creating the row up front instead meant every press of the button
   * left another empty "新对话" in the history, which is exactly the clutter
   * that makes a history list unmanageable.
   *
   * Blocked while a reply is streaming: the in-flight `send()` would still
   * write its result into the thread it started on and stomp the empty state.
   */
  function newThread() {
    if (busy) return;
    setThreadId(null);
    setMessages([]);
    setError(null);
    setHistoryOpen(false);
  }

  function startRename(target: Thread) {
    renameCancelledRef.current = false;
    setRenamingId(target.id);
    setRenameDraft(target.title);
    setHistoryError(null);
  }

  function cancelRename() {
    renameCancelledRef.current = true;
    setRenamingId(null);
  }

  /**
   * The stored title comes back from the server, not from the input: the route
   * trims and caps at 120 characters, so echoing what was typed would let the
   * list and the database disagree.
   */
  async function commitRename(id: string) {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false;
      return;
    }
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next) return; // an empty title is not a rename

    const res = await fetch(`/api/assistant/threads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: { thread?: Thread }; error?: { code?: string; message?: string } }
      | null;
    if (!res.ok || !json?.data?.thread) {
      setHistoryError(apiErrorMessage(t, json?.error?.code, json?.error?.message));
      return;
    }
    const saved = json.data.thread.title;
    setThreads((prev) => prev.map((th) => (th.id === id ? { ...th, title: saved } : th)));
  }

  async function removeThread(target: Thread) {
    if (!confirm(t("assistant.confirmDeleteThread", { title: target.title }))) return;
    setHistoryError(null);
    setDeletingId(target.id);
    try {
      const res = await fetch(`/api/assistant/threads/${target.id}`, { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      if (!res.ok) {
        setHistoryError(apiErrorMessage(t, json?.error?.code, json?.error?.message));
        return;
      }
      setThreads((prev) => prev.filter((th) => th.id !== target.id));
      // Deleting the conversation on screen leaves nothing to show. Clearing
      // the id here means the next message starts a new thread, instead of
      // sending a stale id and earning a 404 the user did nothing to deserve.
      if (threadId === target.id) {
        setThreadId(null);
        setMessages([]);
        setError(null);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  /**
   * Take files from the picker.
   *
   * Refused here, by name, rather than uploaded and then refused: a turn that
   * only fails after the bytes have crossed the network teaches nothing and
   * costs the most when the file is the biggest one.
   */
  function addFiles(list: FileList | null): void {
    if (!list || list.length === 0) return;
    const refused: string[] = [];
    const accepted: PendingUpload[] = [];
    const files = uploadFilesRef.current;

    for (const file of Array.from(list)) {
      const type = file.type.toLowerCase().trim();
      if (!UPLOADABLE.has(type)) {
        refused.push(`${file.name}（${type || "未知类型"}）`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        refused.push(`${file.name} 超过 25MB`);
        continue;
      }
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      if (files.has(key) || accepted.some((u) => u.key === key)) continue;
      files.set(key, file);
      accepted.push({
        key,
        name: file.name,
        contentType: type,
        size: file.size,
        previewUrl: URL.createObjectURL(file),
      });
    }

    setUploads((prev) => {
      const next = [...prev, ...accepted].slice(0, MAX_UPLOADS);
      // Anything over the limit keeps its row but is dropped, so the chip row
      // and what will actually be sent can never disagree.
      for (const extra of [...prev, ...accepted].slice(MAX_UPLOADS)) {
        files.delete(extra.key);
        URL.revokeObjectURL(extra.previewUrl);
        refused.push(`${extra.name} 超过一次 ${MAX_UPLOADS} 个的上限`);
      }
      return next;
    });

    setError(refused.length ? `这些文件没有加上：${refused.join("、")}` : null);
  }

  function dropUpload(key: string): void {
    uploadFilesRef.current.delete(key);
    setUploads((prev) => {
      const gone = prev.find((u) => u.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((u) => u.key !== key);
    });
  }

  /**
   * Whether this turn has somewhere to go.
   *
   * The account path always does — it runs on this deployment as the signed-in
   * user — so it is the stored upstream, not the assistant, that is missing.
   * Gating the composer on `configured` alone told someone with account identity
   * switched on that the assistant was not set up, and the settings drawer they
   * were then sent to had no way to fix it.
   */
  /**
   * Which model is answering, named in the top bar.
   *
   * Depends on the credential: the stored upstream's model on the key path, one
   * of this deployment's on the account path. Showing the stored one either way
   * would make switching credentials look like it changed nothing — and with no
   * upstream stored at all, it would name a model that is not in the call.
   */
  /**
   * What actually answers a turn, named on screen.
   *
   * There is no fallback here, and that is the point. It used to fall back to
   * "whichever the server picked" for the account path, so a conversation could
   * be having its replies written by a model the reader had no way to name.
   * "Which model is this" decides what the answer is worth, so with nothing
   * chosen it says nothing chosen and the composer stays closed.
   */
  const effectiveModelLabel = config.model || t("assistant.unconfiguredModel");

  /**
   * A turn needs a model, on both paths.
   *
   * One rule, from the server, so the button, the request and the route cannot
   * disagree about whether this turn is allowed.
   */
  const canSend = config.ready;
  const missingUpstream = !config.ready;

  async function send() {
    const text = input.trim();
    const files = uploadFilesRef.current;
    const picked = uploads.filter((u) => files.has(u.key));
    // A turn of nothing but a picture is a normal thing to send, so it is
    // allowed; the server fills in what the model should be told about it.
    if ((!text && picked.length === 0) || busy || !canSend) return;
    setBusy(true);
    setError(null);
    setInput("");
    setUploads([]);
    setLiveArtifacts([]);

    // The local echo shows the picture from the object URL the chip was using;
    // the server's own reference replaces it when the turn lands.
    const localAttachments: Attachment[] = picked.map((u) => ({
      id: u.key,
      kind: u.contentType.startsWith("image/") ? "image" : u.contentType.startsWith("audio/") ? "audio" : "video",
      contentType: u.contentType,
      url: u.previewUrl,
      bytes: u.size,
      name: u.name,
    }));

    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: "user",
        content: text,
        ...(localAttachments.length ? { attachments: localAttachments } : {}),
      },
      { id: "streaming", role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const attachments = await Promise.all(
        picked.map(async (u) => ({
          name: u.name,
          contentType: u.contentType,
          data: await toBase64(files.get(u.key)!),
        })),
      );

      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(threadId ? { threadId } : {}),
          // Only the secret travels with the turn. Which credential it is, and
          // which model answers, are both read from the stored configuration —
          // the request used to carry them too, which is how a mode could be
          // chosen for one turn and be gone on the next.
          ...(config.mode === "key" && relayKey.trim() ? { relayKey: relayKey.trim() } : {}),
          ...(attachments.length ? { attachments } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errJson = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(errJson?.error?.message ?? `HTTP ${res.status}`);
        setMessages((prev) => prev.filter((m) => m.id !== "streaming"));
        return;
      }

      const created = res.headers.get("x-assistant-thread");
      if (created) {
        createdThreadRef.current = created;
        setThreadId(created);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      /** One `data:` frame, or nothing. */
      const handle = (raw: string) => {
        if (!raw.startsWith("data:")) return;
        const data = raw.slice(5).trim();
        if (!data || data === "[DONE]") return;

        let evt: EventPayload;
        try {
          evt = JSON.parse(data) as EventPayload;
        } catch {
          return;
        }

        if (evt.type === "delta" && evt.text) {
          const chunk = evt.text;
          setMessages((prev) =>
            prev.map((m) => (m.id === "streaming" ? { ...m, content: m.content + chunk } : m)),
          );
        } else if (evt.type === "error" && evt.text) {
          setError(evt.text);
        } else if (evt.type === "artifact" && evt.artifacts?.length) {
          // Show it the moment the tool finishes, rather than waiting for the
          // turn to end and the thread to reload.
          setLiveArtifacts((prev) => [...prev, ...evt.artifacts!]);
        } else if (evt.type === "done" && evt.data?.pendingActions?.length) {
          void loadPendingCount();
          router.refresh();
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let at = buffer.indexOf("\n\n");
        while (at !== -1) {
          const raw = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
          handle(raw);
        }
      }
      // Whatever is left has no terminator of its own. Dropping it loses the
      // tail of the answer with nothing on screen to say so — the reader is
      // closed by then, so it is never coming in another chunk.
      handle(buffer.trim());
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setMessages((prev) =>
        prev.map((m, i) =>
          m.id === "streaming" && i === prev.length - 1 ? { ...m, id: `a-${Date.now()}` } : m,
        ),
      );
      // `threadId` here is the value from the render that started this turn, so
      // on the first message of a conversation it is still null even though the
      // response headers named the thread the turn created. Reloading that one
      // is what replaces the streamed transcript with what was actually
      // persisted - including the tool results the stream never carried.
      const settled = createdThreadRef.current ?? threadId;
      if (settled) void loadThread(settled);
      // The history *list* is a separate read from the transcript, and a
      // conversation this turn just created is not in it. Refreshing only the
      // transcript is why a brand new conversation could be opened and used
      // and still not be in the history until the page was reloaded — the list
      // was last read before the thread existed.
      void loadThreads();
    }
  }

  const currentTitle = threads.find((th) => th.id === threadId)?.title;
  const suggestions = [
    t("assistant.suggestions.1"),
    t("assistant.suggestions.2"),
    t("assistant.suggestions.3"),
    t("assistant.suggestions.4"),
  ];

  return (
    /**
     * The height is the viewport minus the app header, and that is all: this
     * route's page padding is dropped by the shell (see EDGE_TO_EDGE_ROUTES) so
     * there is nothing else to subtract.
     *
     * It is deliberately NOT cancelled here with `-mx-*`. The page body is
     * rendered inside an `overflow-hidden` box, so a child reaching outside its
     * parent gets clipped, and the chat's top bar and composer were being cut
     * off at the edges. That hid on a desktop — the centred reading column left
     * slack to absorb the overflow — and showed up the moment the column was the
     * full width of a phone. Nothing should sit outside the box here.
     *
     * `100vh` first, then `100dvh`. They mean different things: `vh` is the
     * viewport with the browser chrome hidden, `dvh` is the one you can
     * actually see. On a phone dvh is right - it follows the collapsing address
     * bar and the on-screen keyboard - but a browser that does not know `dvh`
     * discards the whole declaration, and a height-less flex column collapses
     * to its content, which looks like a page that failed to render. Tailwind
     * emits these in source order, so the second wins where it is understood
     * and the first stands in where it is not.
     *
     * No minimum height. A floor is a promise the viewport may not keep - a
     * phone in landscape is shorter than 384px - and honouring it means the
     * composer falls below the fold on exactly the devices with least room.
     */
    <div className="flex h-[calc(100vh-3.5rem)] h-[calc(100dvh-3.5rem)] flex-col">
      {/* ---- top bar: a new chat on the left, what is answering on the right ---- */}
      <div className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-2 border-b pb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={newThread}
          disabled={busy}
          title={t("assistant.newThread")}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="hidden sm:inline">{t("assistant.newThread")}</span>
        </Button>

        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          {t("assistant.history")}
          {threads.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">{threads.length}</span>
          )}
        </Button>

        <div className="flex-1" />

        {pendingPanel && (
          <Button variant="ghost" size="sm" onClick={() => setPendingOpen(true)}>
            {t("actions.titleShort")}
            {pendingCount > 0 && (
              <Badge tone="warning" className="ml-1.5">
                {pendingCount}
              </Badge>
            )}
          </Button>
        )}

        <span
          className="hidden max-w-[14rem] truncate rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground sm:inline-block"
          title={effectiveModelLabel}
        >
          {effectiveModelLabel}
        </span>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSettingsOpen(true)}
          title={t("assistant.settings.title")}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Button>
      </div>

      {/* ---- conversation ---- */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          /* Tighter than it looks: on a short window this block is a quarter of
             the message area, and it is the one thing on screen that is
             decorative. Heading down a size, the gap halved, the cards one row
             of padding shallower. */
          <div className="mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center gap-4 px-4 text-center">
            <div className="space-y-1.5">
              <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
                {t("assistant.emptyTitle")}
              </h2>
              <p className="mx-auto max-w-prose text-sm text-muted-foreground">
                {t("assistant.emptyState")}
              </p>
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setInput(s);
                    inputRef.current?.focus();
                  }}
                  className="rounded-lg border border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-4xl space-y-5 px-1 py-6">
            {messages.map((m) =>
              m.role === "tool" ? (
                <ToolResultCard
                  key={m.id}
                  toolName={m.toolName}
                  label={t("assistant.toolResult")}
                  content={m.content}
                  downloadLabel={t("assistant.artifact.download")}
                  pretty={pretty}
                />
              ) : m.role === "user" ? (
                <div key={m.id} className="flex flex-col items-end gap-2">
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="max-w-[85%]">
                      <MediaArtifacts
                        artifacts={m.attachments.map((a) => ({
                          id: a.id,
                          kind: a.kind,
                          contentType: a.contentType,
                          url: a.url,
                          bytes: a.bytes,
                        }))}
                        downloadLabel={t("assistant.artifact.download")}
                      />
                    </div>
                  )}
                  {m.content && (
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm">
                      {m.content}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className="flex gap-3">
                  <div
                    aria-hidden
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
                  >
                    AI
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5 text-sm">
                    <AssistantBody
                      text={m.content}
                      thinkingLabel={t("assistant.thinkingBlock")}
                      pretty={pretty}
                      expandLabel={t("assistant.expand")}
                      collapseLabel={t("assistant.collapse")}
                    />
                  </div>
                </div>
              ),
            )}
            {/* Artefacts from the turn still streaming. Once the turn ends the
                thread reloads and these are rendered from the stored tool
                messages instead, so this is cleared rather than duplicated. */}
            {busy && <MediaArtifacts artifacts={liveArtifacts} downloadLabel={t("assistant.artifact.download")} />}
          </div>
        )}
      </div>

      {/* ---- composer: one rounded box, send button inside it ---- */}
      <div className="shrink-0 bg-background pb-2">
        <div className="mx-auto w-full max-w-4xl">
          {error && (
            <pre className="mb-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </pre>
          )}

          {missingUpstream && (
            <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
              {t("assistant.notConfigured")}{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setSettingsOpen(true)}
              >
                {t("assistant.openSettings")}
              </button>
            </p>
          )}

          {pendingCount > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">{t("assistant.pendingAction")}</p>
          )}

          {uploads.length > 0 && (
            <div className="flex flex-wrap gap-2 pb-2">
              {uploads.map((u) => (
                <div
                  key={u.key}
                  className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pl-1.5 pr-1 text-xs"
                >
                  {u.contentType.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a local
                    // object URL for a chip the user is about to send.
                    <img src={u.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-[10px] uppercase">
                      {u.contentType.split("/")[1] ?? "?"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground">{u.name}</span>
                    <span className="text-muted-foreground">{humanSize(u.size)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => dropUpload(u.key)}
                    aria-label={`移除 ${u.name}`}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <label
              className="mb-0.5 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("assistant.attach.hint")}
            >
              <Paperclip className="h-4 w-4" aria-hidden />
              <span className="sr-only">{t("assistant.attach.hint")}</span>
              <input
                type="file"
                multiple
                accept="image/*,audio/*,video/mp4,video/webm"
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  // Reset so picking the same file twice in a row still fires.
                  e.target.value = "";
                }}
              />
            </label>
            <textarea
              id="assistant-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder={
                uploads.length > 0
                  ? t("assistant.placeholderHint.withFiles")
                  : t("assistant.placeholderHint")
              }
              className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
            />
            {busy ? (
              <Button size="icon" variant="ghost" onClick={() => abortRef.current?.abort()}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={send}
                disabled={(!input.trim() && uploads.length === 0) || !canSend}
                aria-label={t("assistant.send")}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </Button>
            )}
          </div>

          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            {currentTitle ?? t("assistant.composerHint")}
          </p>
        </div>
      </div>

      {/* ---- drawers ---- */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("assistant.history")}</SheetTitle>
            <SheetDescription>{t("assistant.historyDesc")}</SheetDescription>
          </SheetHeader>
          {/* The new-chat button is an action, the rows below it are a list.
              At space-y-1 they read as one block, and a 28px row with a 4px gap
              is below the comfortable target for a tappable row. */}
          <div className="mt-4 space-y-1.5">
            <Button
              variant="outline"
              className="mb-2 w-full justify-start"
              onClick={newThread}
              disabled={busy}
            >
              + {t("assistant.newThread")}
            </Button>
            {historyError && (
              <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {historyError}
              </p>
            )}
            {threads.length === 0 && (
              <p className="px-1 py-3 text-sm text-muted-foreground">{t("assistant.noHistory")}</p>
            )}
            <div className="space-y-0.5">
            {threads.map((th) => {
              const renaming = renamingId === th.id;
              return (
                <div
                  key={th.id}
                  className={`group flex items-center rounded-md pr-1 focus-within:bg-accent ${
                    th.id === threadId ? "bg-accent font-medium" : "hover:bg-accent"
                  }`}
                >
                  {renaming ? (
                    <input
                      value={renameDraft}
                      // eslint-disable-next-line jsx-a11y/no-autofocus -- the row it
                      // replaces is one click away and the caret belongs in the title.
                      autoFocus
                      maxLength={120}
                      aria-label={t("assistant.renameThread")}
                      title={t("assistant.renameThreadHint")}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename(th.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(th.id);
                        } else if (e.key === "Escape") {
                          // Escape means "cancel here", so it must not also close
                          // the drawer the input lives in.
                          e.preventDefault();
                          e.stopPropagation();
                          cancelRename();
                        }
                      }}
                      className="min-w-0 flex-1 rounded bg-background px-2 py-1.5 text-sm outline-none ring-1 ring-ring"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setThreadId(th.id);
                        setHistoryOpen(false);
                      }}
                      title={th.title}
                      className="min-w-0 flex-1 truncate rounded-md px-2 py-2 text-left text-sm leading-snug"
                    >
                      {th.title}
                    </button>
                  )}

                  {!renaming && (
                    <>
                      <button
                        type="button"
                        onClick={() => startRename(th)}
                        aria-label={t("assistant.renameThread")}
                        title={t("assistant.renameThreadHint")}
                        className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeThread(th)}
                        disabled={deletingId === th.id}
                        aria-label={t("assistant.deleteThread")}
                        title={t("assistant.deleteThread")}
                        className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("assistant.settings.title")}</SheetTitle>
            <SheetDescription>{t("assistant.settings.desc")}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            {/* Whether a reply is rendered or shown raw. A display choice, so
                it lives with the other things you can change about how this
                screen looks rather than with the model configuration. */}
            <div className="rounded-lg border border-border p-3">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                  checked={pretty}
                  onChange={(e) => {
                    setPretty(e.target.checked);
                    writePretty(e.target.checked);
                  }}
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {t("assistant.pretty.switch")}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t("assistant.pretty.hint")}
                  </span>
                </span>
              </label>
            </div>

            {/*
              The credential first, and the upstream only on the key path.

              These were one list, and the order was backwards: the choice came
              first and the address and key came below it, so a reader who chose
              the account path was then asked for a key anyway — three lines under
              a line that says none is needed. The key path still has to be
              configured; the account path has an upstream by construction, this
              deployment, and asking for its address and key was asking for the
              one thing it does not use.
            */}
            {/*
              One configuration, one place.

              The drawer used to hold the mode switch, an account-path model
              dropdown and — only on the key path — the settings form, which is
              three controls for two settings, two of them unsaved. It is now a
              single form that decides the mode and shows only that mode's
              fields, and the chat is told which model is answering rather than
              being able to change it.
            */}
            <section className="space-y-2">
              <header>
                <h3 className="text-sm font-medium text-foreground">
                  {t("assistant.settings.drawerTitle")}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("assistant.settings.drawerDesc")}
                </p>
              </header>
              {settingsPanel}
            </section>

            {/*
              The per-turn relay key, and the whole section with it.

              Only the input used to be conditional, so on the account path this
              left a heading and a paragraph about "which identity the tools
              should use" standing over nothing — a question the mode switch
              above already answers, re-asked in the same drawer. Gating the
              section rather than the field is the fix: on the account path there
              is no such key, so there is nothing here to say.
            */}
            {credentialMode === "key" && (
              <section className="space-y-2">
                <header>
                  <h3 className="text-sm font-medium text-foreground">
                    {t("assistant.credential.perTurnTitle")}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("assistant.credential.perTurnDesc")}
                  </p>
                </header>
                <PerTurnKeyField value={relayKey} onChange={setRelayKey} />
              </section>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {pendingPanel && (
        <Sheet open={pendingOpen} onOpenChange={setPendingOpen}>
          <SheetContent side="right" className="overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{t("actions.title")}</SheetTitle>
              <SheetDescription>{t("actions.desc")}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-3">{pendingPanel}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
