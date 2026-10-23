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
import { Switch } from "@/components/ui/Switch";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/Sheet";
import { useT } from "@/components/i18n/I18nProvider";
import { readPretty, writePretty } from "@/lib/assistant/pretty";
import { PendingErrorProvider } from "./PendingActions";
import { latestRead } from "@/lib/assistant/latest-read";
import type { AssistantConfig } from "@/lib/assistant/config";
import { announcePendingChanged, onPendingChanged } from "@/lib/assistant/pending-bus";
import { MediaArtifacts, ToolResultCard, AssistantBody, QuestionCard } from "./MediaArtifacts";
import type { ArtifactRef } from "@/lib/db/assistant-artifacts";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { Globe, Pencil, Trash2, Paperclip, X } from "lucide-react";
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
  /** This conversation's search choice; null inherits the user's default. */
  webSearch: boolean | null;
}

/**
 * A question the assistant put to the person in front of the screen.
 *
 * Mirrors `UserQuestion` on the server. Re-declared rather than imported
 * because this file is a client component and the server module pulls the
 * whole tool catalogue with it.
 */
interface UserQuestion {
  question: string;
  options?: string[];
  placeholder?: string;
  hint?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * What the model thought, when it thought.
   *
   * Its own field rather than something parsed back out of `content`: most
   * vendors send it separately, and the one that does not has it split out of
   * the stream instead. Reconstructing it from the text cannot work, because by
   * then the tags are gone.
   */
  reasoning?: string;
  toolName?: string | null;
  /**
   * A question the assistant is waiting on, carried on the message so it
   * survives the stream ending and the thread being reloaded. Answering it
   * clears this and sends the answer as the next user message.
   */
  question?: UserQuestion | null;
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
  | { type: "reasoning"; text?: string }
  | { type: "tool"; toolName?: string; text?: string }
  | { type: "artifact"; artifacts?: ArtifactRef[] }
  | { type: "action"; text?: string; data?: { actionId?: string } }
  | { type: "question"; question?: UserQuestion }
  | { type: "error"; text?: string }
  | { type: "done"; data?: { pendingActions?: string[]; usage?: unknown } };

/**
 * The seam between a stored tool result's prose and its machine-readable half.
 *
 * Written out here rather than imported from `tools.ts`: that module is server
 * code and importing it would pull the whole tool catalogue — and everything it
 * reaches — into the browser bundle. The two copies have to stay identical, and
 * `assistant-ask-user.test.ts` is what keeps them that way: it reads this
 * source and the server's, and fails if they ever disagree.
 */
const ASK_USER_MARKER = "<!-- ask_user -->";

/**
 * Put the questions back where they belong after a reload.
 *
 * A question lives on an `ask_user` tool row, and the reader expects it on the
 * assistant message that asked it — the row is plumbing. So each one is folded
 * into the assistant message above it, and the tool row itself is dropped:
 * rendering it as well would show the question twice, once answerable and once
 * as a JSON blob in a details panel.
 *
 * A question counts as answered when a user message follows it. That is the
 * same conclusion the live view reaches by holding the id, and it is derived
 * from the transcript rather than from session state, which is the whole point
 * — otherwise a reload would quietly un-answer a question that was answered.
 */
function restoreQuestions(rows: ChatMessage[]): {
  messages: ChatMessage[];
  answered: Set<string>;
} {
  const messages: ChatMessage[] = [];
  const answered = new Set<string>();
  let answeredEverythingAfter = false;

  for (const row of rows) {
    if (row.role === "user") {
      // Any user turn answers whatever question is still open above it.
      answeredEverythingAfter = true;
      messages.push(row);
      continue;
    }
    if (answeredEverythingAfter) {
      const last = messages[messages.length - 1];
      if (last?.question) answered.add(last.id);
      answeredEverythingAfter = false;
    }
    if (row.role === "tool" && row.toolName === "ask_user") {
      const at = row.content?.indexOf(ASK_USER_MARKER) ?? -1;
      if (at === -1) {
        messages.push(row);
        continue;
      }
      let question: UserQuestion | null = null;
      try {
        question = JSON.parse(row.content.slice(at + ASK_USER_MARKER.length).trim()) as UserQuestion;
      } catch {
        question = null;
      }
      if (!question?.question) {
        messages.push(row);
        continue;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, question };
      } else {
        messages.push({ id: row.id, role: "assistant", content: "", question });
      }
      continue;
    }
    messages.push(row);
  }
  return { messages, answered };
}

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
  /** Whether the deployment can search at all (feature on + a backend). */
  webSearchAvailable: boolean;
  /** What the user chose for new conversations. */
  webSearchDefault: boolean;
  settingsPanel: React.ReactNode;
  pendingPanel: React.ReactNode | null;
}

export function AssistantChat({
  config,
  webSearchAvailable,
  webSearchDefault,
  settingsPanel,
  pendingPanel,
}: Props) {
  const t = useT();

  /**
   * Whether replies are rendered or shown raw. Kept in state as well as
   * localStorage so the change is instant; the stored value is what survives a
   * reload.
   */
  const [pretty, setPretty] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * This conversation's web-search switch.
   *
   * The server is the authority: the boolean travels with every message and
   * the chat route refuses the tool when it is false. This state is what the
   * composer renders, and it is restored from the thread when one is opened.
   */
  const [webSearch, setWebSearch] = useState(webSearchDefault);
  const [input, setInput] = useState("");
  /** Files picked but not yet sent. The preview chips render from here. */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  /** Kept beside the chips so `send` can read the bytes without a second picker. */
  const uploadFilesRef = useRef(new Map<string, File>());
  /**
   * Every object URL this page has created and not yet handed back.
   *
   * A blob URL is pinned to the document until it is revoked, and the whole
   * file behind it with it. Two of the three places that could release one —
   * overflowing the attachment limit, and dropping a chip — never saw the
   * URLs a *sent* attachment used: `send` cleared `uploads` while the local
   * echo kept rendering the picture from that URL until the server's own
   * reference replaced it. So a 25 MB clip sent in a long session stayed
   * resident for as long as the tab was open. Revoking on unmount is late but
   * it is bounded, and it cannot break a preview still on screen.
   */
  const liveObjectUrlsRef = useRef(new Set<string>());
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
  /**
   * Why the last approval or rejection was refused, held out here so closing
   * the drawer does not take it with it. See `PendingActions` for the whole
   * argument; the short version is that the banner was made to survive the
   * queue emptying, and nobody checked the other way this panel stops being on
   * screen — which is that it does.
   */
  const [pendingDecisionError, setPendingDecisionError] = useState<string | null>(null);
  /**
   * Which questions already have a reply.
   *
   * Held here rather than on the message because the answer is an ordinary next
   * message: the question card has to know it is done without that answer being
   * edited into the question itself, and a reloaded thread has to reach the same
   * conclusion — which it does, because a question with a user message after it
   * is a question that was answered.
   */
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState<Set<string>>(new Set());

  /**
   * Open a drawer after the current gesture has finished.
   *
   * A Radix sheet mounts its full-screen overlay the moment `open` flips, and the
   * click that asked for it is still propagating while that happens. The overlay —
   * and the buttons underneath it — are then in the document under a pointer that
   * has not moved, and the same gesture lands on one of them. Opening the settings
   * drawer did exactly that: the sheet came up and closed again, and the
   * conversation underneath was reset by the "new chat" button the click had
   * reached instead.
   *
   * Deferring by a tick means the gesture has already finished by the time
   * anything is mounted, so there is nothing left to retarget. Every drawer goes
   * through here because the exposure is identical for all three.
   */
  const openDrawer = (setter: (open: boolean) => void) => () => {
    setTimeout(() => setter(true), 0);
  };

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

  /**
   * The box grows with what you type, up to the cap `max-h-40` sets, and
   * scrolls past it.
   *
   * Not cosmetic. Enter inserts a newline now, so composing anything longer
   * than a sentence means pressing it several times — into a textarea that
   * stays one row tall and scrolls internally, which puts the caret on a line
   * nobody can see. The height is written imperatively because a textarea's
   * height is a property; neither `rows` nor a max-height can derive it from
   * the content.
   *
   * Reset to `auto` first: without that the element can only grow, and clearing
   * a long message leaves a tall empty box behind it.
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  /**
   * Hand back every blob URL still outstanding when this page goes away.
   *
   * Deliberately not on send: the local echo renders the picture from that URL
   * until the server's own reference replaces it, so revoking it there would
   * leave a broken image on a turn that had not finished writing.
   */
  useEffect(() => {
    const live = liveObjectUrlsRef.current;
    return () => {
      for (const url of live) URL.revokeObjectURL(url);
      live.clear();
    };
  }, []);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/assistant/threads", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { data?: { threads?: Thread[] } } | null;
    // An empty list and a failed read are different states, and only one of
    // them is the truth. Rewriting to `[]` on a gateway error page or a dropped
    // connection tells the reader their history is empty — which is also what
    // they are told after a failed deploy, when nothing is actually wrong with
    // their history.
    if (!res.ok || !json?.data) return;
    setThreads(json.data.threads ?? []);
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
      | { data?: { messages?: ChatMessage[]; thread?: { webSearch?: boolean | null } } }
      | null;
    // A read that has been overtaken is not an error, it is just obsolete.
    if (!transcriptReadRef.current.accept(token)) return;
    // Nor is a read that failed. `json?.data?.messages ?? []` conflated "this
    // thread has no messages yet" with "the server did not answer with a
    // thread": a 502 — the shape a container restart takes while the gateway
    // returns an HTML error page — left `res.json()` null and the transcript
    // was rewritten to nothing. The conversation was not deleted, nothing on
    // screen said so, and nothing would put it back until the next read.
    if (!res.ok || !json?.data) {
      setError(t("assistant.loadFailed"));
      return;
    }
    const restored = restoreQuestions(json.data.messages ?? []);
    setAnsweredQuestionIds(restored.answered);
    setMessages(restored.messages);
    // A thread with no explicit choice (null) follows the user's default, which
    // is also what the server will do on the next turn.
    setWebSearch(json.data.thread?.webSearch ?? webSearchDefault);
  }, [webSearchDefault]);

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
   *
   * `wasHiddenRef` is what keeps this from firing constantly. Recovering means
   * aborting a turn that may be perfectly healthy, so it may only happen after
   * the page has genuinely been in the background — a real hidden state that
   * something could have frozen in. A bare `focus` event is not that: it fires
   * every time the user clicks back into this window, and the stream behind it
   * is usually still running. Browsers throttle timers in a hidden tab, not
   * connections, so a visible tab that merely lost focus has lost nothing and
   * has no reason to be thrown away.
   */
  const wasHiddenRef = useRef(false);
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") wasHiddenRef.current = true;
    };
    const onVisible = () => {
      if (!wasHiddenRef.current) return;
      if (document.visibilityState !== "visible") return;
      wasHiddenRef.current = false;
      if (!busy || !threadId) return;
      abortRef.current?.abort();
      setBusy(false);
      void loadThread(threadId);
    };
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
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

  // The badge and the list each keep a copy of the pending count, and a turn
  // only ever refreshed the one that happened to be here. The other half of
  // this page was then showing a number from whenever it was last mounted —
  // which, on a tab left open beside a long conversation, is a long time ago.
  useEffect(() => onPendingChanged(() => void loadPendingCount()), [loadPendingCount]);

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
    // Retire every read still in flight before clearing the transcript. The
    // effect below reaches the `else setMessages([])` branch when there is no
    // threadId, and that branch claims no sequence number — so a `loadThread`
    // for the previous conversation, issued by the `finally` of the turn that
    // just finished, still held the newest token when it landed and wrote its
    // messages over the empty state. The old conversation came back, and
    // nothing afterwards would clear it again. The window is one round trip,
    // which is exactly the window in which someone reaches for "new chat".
    transcriptReadRef.current.begin();
    setThreadId(null);
    setMessages([]);
    setError(null);
    setHistoryOpen(false);
    // A new conversation inherits the user's default rather than carrying the
    // previous conversation's choice forward as a hidden setting.
    setWebSearch(webSearchDefault);
  }

  /**
   * Flip this conversation's search switch.
   *
   * The value also travels with the next message, so a failed PATCH here costs
   * a persisted preference, not the toggle: the turn that follows still uses
   * the state the reader just chose.
   */
  function toggleWebSearch(): void {
    if (!webSearchAvailable || busy) return;
    const next = !webSearch;
    setWebSearch(next);
    if (!threadId) return; // The first turn stores it when it creates the thread.
    void fetch(`/api/assistant/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webSearch: next }),
    }).catch(() => {
      // Nothing to repair here: the next turn carries the same boolean.
    });
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
      const previewUrl = URL.createObjectURL(file);
      liveObjectUrlsRef.current.add(previewUrl);
      accepted.push({
        key,
        name: file.name,
        contentType: type,
        size: file.size,
        previewUrl,
      });
    }

    setUploads((prev) => {
      const next = [...prev, ...accepted].slice(0, MAX_UPLOADS);
      // Anything over the limit keeps its row but is dropped, so the chip row
      // and what will actually be sent can never disagree.
      for (const extra of [...prev, ...accepted].slice(MAX_UPLOADS)) {
        files.delete(extra.key);
        URL.revokeObjectURL(extra.previewUrl);
        liveObjectUrlsRef.current.delete(extra.previewUrl);
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
      if (gone) {
        URL.revokeObjectURL(gone.previewUrl);
        liveObjectUrlsRef.current.delete(gone.previewUrl);
      }
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

  /**
   * Answer a question the assistant asked.
   *
   * The reply goes into the composer and is sent by the ordinary path rather
   * than by a second one, because "the user typed this" and "the user clicked
   * this" must be indistinguishable to everything downstream — the stored
   * transcript, the usage row, and the model itself. A separate route would
   * have been a place for those to drift.
   *
   * The answer is prefixed with the question it answers. A turn that ends on
   * "which price?" leaves the next turn opening on an assistant message whose
   * text is the question — and "210 / 840" as a reply to that is a guess the
   * model has to make about what the numbers mean.
   */
  function answerQuestion(questionId: string, answer: string): void {
    setAnsweredQuestionIds((prev) => new Set(prev).add(questionId));
    const message = messages.find((m) => m.id === questionId);
    const asked = message?.question?.question?.trim();
    setInput(asked ? `${asked}\n\n${answer}` : answer);
    // Sent on the next tick so the composer state is committed first — `send`
    // reads `input`, and setting it in the same tick would send the old value.
    queueMicrotask(() => void send());
  }

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
    // Retire the sent files, or they stay "already chosen" forever. `addFiles`
    // dedupes against this map, so the same picture chosen twice — "translate
    // this one the other way" — matched its own key and was skipped in silence:
    // no chip appeared, nothing said why, and the send button stayed disabled.
    for (const u of picked) files.delete(u.key);
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
          // Sent on every turn, not only when it changes: the route stores it
          // on the thread and uses it for this turn, so a reload cannot make
          // the conversation's state and the turn's behavior disagree.
          webSearch,
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
      /**
       * Whether the turn said it finished.
       *
       * The stream can end without it — a proxy in front of the app has its own
       * read timeout, and a client that is disconnected mid-turn sees the body
       * simply stop. Without this the conversation just stops, which is
       * indistinguishable from the model deciding it was done.
       */
      let sawDone = false;
      /**
       * Whether the turn already said *why* it stopped, in its own words.
       *
       * The stream ends the same way whether the connection dropped or the
       * turn failed, so the bottom of this loop cannot tell those apart — and
       * the interruption message it falls back to was overwriting the real
       * error every time, replacing "upstream returned 504" with "the
       * connection dropped". The one message that names a cause was being
       * erased by the one that admits there isn't one.
       */
      let sawError = false;

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
        } else if (evt.type === "reasoning" && evt.text) {
          // Collected into the streaming message rather than printed as it
          // arrives: it arrives in fragments, and a paragraph that grows under
          // the reader's eyes is harder to read than one that is simply there.
          const chunk = evt.text;
          setMessages((prev) =>
            prev.map((m) => (m.id === "streaming" ? { ...m, reasoning: (m.reasoning ?? "") + chunk } : m)),
          );
        } else if (evt.type === "error" && evt.text) {
          sawError = true;
          setError(evt.text);
        } else if (evt.type === "question" && evt.question) {
          // Lands on the assistant message rather than a banner: it is part of
          // what the assistant said, and it has to stay answerable after a
          // reload — a question in a dismissible banner is a question that
          // gets lost, which is the state this whole path replaced.
          setMessages((prev) => {
            const rest = prev.filter((m) => m.id !== "streaming");
            const last = rest[rest.length - 1];
            if (last && last.role === "assistant") {
              return [...rest.slice(0, -1), { ...last, question: evt.question! }];
            }
            return [...rest, { id: "streaming", role: "assistant", content: "", question: evt.question! }];
          });
        } else if (evt.type === "artifact" && evt.artifacts?.length) {
          // Show it the moment the tool finishes, rather than waiting for the
          // turn to end and the thread to reload.
          setLiveArtifacts((prev) => [...prev, ...evt.artifacts!]);
        } else if (evt.type === "done") {
          sawDone = true;
          if (evt.data?.pendingActions?.length) void loadPendingCount();
          // The badge and the list are two components holding two copies of one
          // number, and this one only ever refreshed its own. Without the second
          // line the count says 3 while the panel under it says 0.
          announcePendingChanged();
          /**
           * No `router.refresh()` here — the bus above is what replaced it, and
           * the note in `pending-bus.ts` says why it never worked: it re-renders
           * the server components and leaves client state where it was. It was
           * left in anyway, so the only thing it did was re-render the server
           * tree at the end of every turn that proposed something.
           *
           * That is the whole trigger for the settings bug, and it is why the
           * drawer only misbehaved *after* a conversation: this line is the only
           * thing that ran between one turn and the next click, and a Radix modal
           * mounted over a tree that had just been re-rendered does not behave like
           * one mounted over an untouched page.
           */
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

      // The body ended and the turn never said it was finished. Something
      // between the app and the browser closed the connection — most often a
      // proxy read timeout during a long model or tool call. Saying so is the
      // whole difference between "the assistant gave up" and "the connection
      // dropped mid-answer", and the reader can act on the second one.
      //
      // Only when the turn did *not* report an error of its own first: a turn
      // that ended by failing also ends without a terminator, and the reason it
      // gave is worth more than a guess about the wire.
      if (!sawDone && !sawError) {
        setError(t("assistant.streamInterrupted"));
      }
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
    <div className="flex h-[calc(100vh-3.5rem)] h-[calc(100dvh-3.5rem)] flex-col lg:h-[100vh] lg:h-[100dvh]">
      {/* ---- top bar: a new chat on the left, what is answering on the right ---- */}
      <div className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-2 border-b pb-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={newThread}
          disabled={busy}
          title={t("assistant.newThread")}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="hidden sm:inline">{t("assistant.newThread")}</span>
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={openDrawer(setHistoryOpen)}
        >
          {t("assistant.history")}
          {threads.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">{threads.length}</span>
          )}
        </Button>

        <div className="flex-1" />

        {pendingPanel && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openDrawer(setPendingOpen)}
          >
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
          type="button"
          variant="ghost"
          size="icon"
          onClick={openDrawer(setSettingsOpen)}
          title={t("assistant.settings.title")}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
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
          <div className="mx-auto w-full max-w-4xl space-y-5 px-3 py-4 sm:px-4 sm:py-6">
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
                    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-muted px-4 py-2.5 text-sm">
                      {m.content}
                    </div>
                  )}
                </div>
              ) : (
                <div key={m.id} className="flex gap-3">
                  <div
                    aria-hidden
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    AI
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5 text-sm">
                    <AssistantBody
                      text={m.content}
                      reasoning={m.reasoning}
                      thinkingLabel={t("assistant.thinkingBlock")}
                      pretty={pretty}
                      expandLabel={t("assistant.expand")}
                      collapseLabel={t("assistant.collapse")}
                    />
                    {m.question && (
                      <QuestionCard
                        question={m.question}
                        answered={answeredQuestionIds.has(m.id)}
                        busy={busy}
                        onAnswer={(answer) => answerQuestion(m.id, answer)}
                        labels={{
                          placeholder: t("assistant.question.placeholder"),
                          send: t("assistant.question.send"),
                          answered: t("assistant.question.answered"),
                        }}
                      />
                    )}
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
                onClick={openDrawer(setSettingsOpen)}
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
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted text-xs uppercase">
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

          <div className="flex items-end gap-2 rounded-lg border border-input bg-background p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
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
            {/*
              Web search, next to the paperclip, where every chat client puts
              it. A button with `aria-pressed` rather than a checkbox because
              the state is "this conversation searches" — a switch, not a
              setting buried in a panel.
            */}
            <button
              type="button"
              onClick={toggleWebSearch}
              aria-pressed={webSearch}
              aria-label={webSearch ? t("assistant.webSearch.on") : t("assistant.webSearch.off")}
              title={
                !webSearchAvailable
                  ? t("assistant.webSearch.unavailable")
                  : webSearch
                    ? t("assistant.webSearch.onHint")
                    : t("assistant.webSearch.offHint")
              }
              disabled={!webSearchAvailable || busy}
              className={`mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${
                webSearch && webSearchAvailable
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              } disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <Globe className="h-4 w-4" aria-hidden />
            </button>
            <textarea
              id="assistant-input"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter types a newline and Shift+Enter sends. The placeholder
                // and the line under the box both say so, so this handler and
                // those two strings have to move together — a hint describing a
                // key that does the opposite is worse than no hint.
                //
                // `isComposing` guards the IME case: while a candidate is being
                // assembled Shift+Enter belongs to the input method, and sending
                // on it would ship half-finished text.
                if (e.key === "Enter" && e.shiftKey && !e.nativeEvent.isComposing) {
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
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </Button>
            )}
          </div>

          <p className="mt-1.5 text-center text-xs text-muted-foreground">
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
            <div className="space-y-1">
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
                        // The clear `newThread` and `removeThread` both do.
                        setError(null);
                        // Show the conversation's own choice immediately; the
                        // transcript read that follows confirms it.
                        setWebSearch(th.webSearch ?? webSearchDefault);
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
              <label
                htmlFor="assistant-pretty"
                className="flex cursor-pointer items-start gap-2.5"
              >
                {/*
                  A switch, not a checkbox: this says "the answers are
                  rendered", and a box in a panel of settings does not say that.
                */}
                <Switch
                  id="assistant-pretty"
                  className="mt-0.5"
                  checked={pretty}
                  onCheckedChange={(checked) => {
                    setPretty(checked);
                    writePretty(checked);
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
        <PendingErrorProvider error={pendingDecisionError} onError={setPendingDecisionError}>
          <Sheet open={pendingOpen} onOpenChange={setPendingOpen}>
            <SheetContent side="right" className="overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t("actions.title")}</SheetTitle>
                <SheetDescription>{t("actions.desc")}</SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3">{pendingPanel}</div>
            </SheetContent>
          </Sheet>
        </PendingErrorProvider>
      )}
    </div>
  );
}
