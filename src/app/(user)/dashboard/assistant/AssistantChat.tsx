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
import { CredentialPanel, type Mode } from "@/lib/assistant/CredentialPanel";
import { apiErrorMessage } from "@/lib/i18n/api-errors";
import { Pencil, Trash2 } from "lucide-react";

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
}

type EventPayload =
  | { type: "delta"; text?: string }
  | { type: "tool"; toolName?: string; text?: string }
  | { type: "action"; text?: string; data?: { actionId?: string } }
  | { type: "error"; text?: string }
  | { type: "done"; data?: { pendingActions?: string[]; usage?: unknown } };

interface Props {
  configured: boolean;
  /** Model name shown in the top bar, so it is obvious what is answering. */
  modelLabel: string;
  settingsPanel: React.ReactNode;
  pendingPanel: React.ReactNode | null;
}

export function AssistantChat({ configured, modelLabel, settingsPanel, pendingPanel }: Props) {
  const t = useT();
  const router = useRouter();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [credentialMode, setCredentialMode] = useState<Mode>("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const loadThread = useCallback(async (id: string) => {
    const res = await fetch(`/api/assistant/threads/${id}`, { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { messages?: ChatMessage[] } }
      | null;
    setMessages(json?.data?.messages ?? []);
  }, []);

  const loadPendingCount = useCallback(async () => {
    if (!pendingPanel) return;
    const res = await fetch("/api/assistant/actions?status=pending", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { actions?: unknown[] } }
      | null;
    setPendingCount(json?.data?.actions?.length ?? 0);
  }, [pendingPanel]);

  useEffect(() => {
    void loadThreads();
    void loadPendingCount();
  }, [loadThreads, loadPendingCount]);

  useEffect(() => {
    if (threadId) void loadThread(threadId);
    else setMessages([]);
  }, [threadId, loadThread]);

  // Follow the tail as tokens arrive, but only when the reader is already near
  // the bottom. Yanking someone back down while they re-read an earlier answer
  // is its own bug.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  async function send() {
    const text = input.trim();
    if (!text || busy || !configured) return;
    setBusy(true);
    setError(null);
    setInput("");

    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text },
      { id: "streaming", role: "assistant", content: "" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(threadId ? { threadId } : {}),
          // Sent only in key mode: the account path has no token to send, which
          // is the whole point of it.
          ...(credentialMode === "key" && relayKey.trim() ? { relayKey: relayKey.trim() } : {}),
          credentialMode,
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
      if (created) setThreadId(created);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let at = buffer.indexOf("\n\n");
        while (at !== -1) {
          const raw = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 2);
          at = buffer.indexOf("\n\n");
          if (!raw.startsWith("data:")) continue;
          const data = raw.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          let evt: EventPayload;
          try {
            evt = JSON.parse(data) as EventPayload;
          } catch {
            continue;
          }

          if (evt.type === "delta" && evt.text) {
            const chunk = evt.text;
            setMessages((prev) =>
              prev.map((m) => (m.id === "streaming" ? { ...m, content: m.content + chunk } : m)),
            );
          } else if (evt.type === "error" && evt.text) {
            setError(evt.text);
          } else if (evt.type === "done" && evt.data?.pendingActions?.length) {
            void loadPendingCount();
            router.refresh();
          }
        }
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
      if (threadId) void loadThread(threadId);
      else void loadThreads();
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
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[28rem] flex-col">
      {/* ---- top bar: a new chat on the left, what is answering on the right ---- */}
      <div className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 border-b pb-2">
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
          title={modelLabel}
        >
          {modelLabel}
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-6 px-4 text-center">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold text-foreground">{t("assistant.emptyTitle")}</h2>
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
                  className="rounded-lg border border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-5 px-1 py-6">
            {messages.map((m) =>
              m.role === "tool" ? (
                <details key={m.id} className="rounded-lg border border-border bg-muted/30 p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    ⚙ {m.toolName ?? t("assistant.toolResult")}
                  </summary>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {m.content}
                  </pre>
                </details>
              ) : m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-sm">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex gap-3">
                  <div
                    aria-hidden
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
                  >
                    AI
                  </div>
                  <div className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 text-sm">
                    {m.content || (
                      <span className="text-muted-foreground">{t("assistant.thinking")}…</span>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {/* ---- composer: one rounded box, send button inside it ---- */}
      <div className="shrink-0 bg-background pb-2">
        <div className="mx-auto w-full max-w-3xl">
          {error && (
            <pre className="mb-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </pre>
          )}

          {!configured && (
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

          <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
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
              placeholder={t("assistant.placeholderHint")}
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
                disabled={!input.trim() || !configured}
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
          <div className="mt-4 space-y-1">
            <Button
              variant="outline"
              className="w-full justify-start"
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
                      className="min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm"
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
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeThread(th)}
                        disabled={deletingId === th.id}
                        aria-label={t("assistant.deleteThread")}
                        title={t("assistant.deleteThread")}
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
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
            {/* Which credential the assistant spends. The account switch is the
                zero-friction path; the pasted key stays for anyone who would
                rather hold something they can revoke by deleting it. */}
            <CredentialPanel
              mode={credentialMode}
              onModeChange={setCredentialMode}
              relayKey={relayKey}
              onRelayKeyChange={setRelayKey}
            />
            {settingsPanel}
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
