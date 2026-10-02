"use client";

/**
 * app/(user)/dashboard/assistant/AssistantChat.tsx
 *
 * The assistant, laid out the way a chat interface is expected to be laid out:
 * the conversation owns the screen, and everything else is behind a control.
 *
 * What that means concretely, and why:
 *
 *   - The message list and the composer fill the available height and do their
 *     own scrolling. The page must not scroll — a chat that scrolls the document
 *     moves the composer out of reach mid-answer.
 *   - The conversation history, the settings form and the admin change queue
 *     are drawers, not stacked cards. They were three blocks of vertical
 *     content pushing the actual conversation below the fold, which is the
 *     opposite of what the page is for.
 *   - The pending-change badge is fetched here rather than passed in, so the
 *     count is live even when the drawer has never been opened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/Sheet";
import { useT } from "@/components/i18n/I18nProvider";

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
  toolCalls?: unknown[];
  toolCallId?: string | null;
}

type EventPayload =
  | { type: "delta"; text?: string }
  | { type: "tool"; toolName?: string; text?: string }
  | { type: "action"; text?: string; data?: { actionId?: string } }
  | { type: "error"; text?: string }
  | { type: "done"; data?: { pendingActions?: string[]; usage?: unknown } };

interface Props {
  configured: boolean;
  /** Rendered inside the settings drawer. */
  settingsPanel: React.ReactNode;
  /** Rendered inside the admin drawer; null for a regular user. */
  pendingPanel: React.ReactNode | null;
}

export function AssistantChat({ configured, settingsPanel, pendingPanel }: Props) {
  const t = useT();
  const router = useRouter();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/assistant/threads", { cache: "no-store" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { threads?: Thread[] } }
      | null;
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
  // the bottom — yanking someone back down while they re-read an earlier
  // answer is worse than letting the newest text land off-screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function newThread() {
    const res = await fetch("/api/assistant/threads", { method: "POST" });
    const json = (await res.json().catch(() => null)) as
      | { data?: { thread?: Thread } }
      | null;
    if (json?.data?.thread) {
      setThreadId(json.data.thread.id);
      setMessages([]);
      setError(null);
      setHistoryOpen(false);
      void loadThreads();
    }
  }

  async function selectThread(id: string) {
    setThreadId(id);
    setHistoryOpen(false);
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
          ...(relayKey.trim() ? { relayKey: relayKey.trim() } : {}),
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

  const currentTitle = threads.find((th) => th.id === threadId)?.title ?? "";

  return (
    <div className="flex h-[calc(100dvh-13rem)] min-h-[26rem] flex-col">
      {/* ---- top bar: everything secondary lives behind one of these ---- */}
      <div className="flex shrink-0 items-center gap-2 border-b pb-2">
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <svg viewBox="0 0 24 24" className="mr-1.5 h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
          {t("assistant.history")}
          {threads.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">{threads.length}</span>
          )}
        </Button>

        {currentTitle && (
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{currentTitle}</span>
        )}

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

        <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
          {t("assistant.settings.title")}
        </Button>
      </div>

      {/* ---- conversation ---- */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4">
            <p className="max-w-prose text-center text-sm text-muted-foreground">
              {t("assistant.emptyState")}
            </p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4 px-1">
            {messages.map((m) =>
              m.role === "tool" ? (
                <details key={m.id} className="rounded-md border border-border bg-muted/30 p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    ⚙ {m.toolName ?? t("assistant.toolResult")}
                  </summary>
                  <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {m.content}
                  </pre>
                </details>
              ) : m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="whitespace-pre-wrap break-words text-sm">
                  {m.content || (
                    <span className="text-muted-foreground">{t("assistant.thinking")}…</span>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </div>

      {/* ---- composer ---- */}
      <div className="shrink-0 space-y-2 border-t pt-3">
        {!configured && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {t("assistant.notConfigured")}
          </p>
        )}

        {error && (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </pre>
        )}

        {pendingCount > 0 && (
          <p className="text-xs text-muted-foreground">{t("assistant.pendingAction")}</p>
        )}

        <Input
          label={t("assistant.gatewayKey")}
          hint={t("assistant.gatewayKeyHint")}
          type="password"
          autoComplete="off"
          placeholder="sk-relay-..."
          value={relayKey}
          onChange={(e) => setRelayKey(e.target.value)}
          className="h-8 text-xs"
        />

        <div className="space-y-1.5">
          <label htmlFor="assistant-input" className="block text-sm font-medium text-foreground">
            {t("assistant.placeholder")}
          </label>
          <textarea
            id="assistant-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder={t("assistant.placeholderHint")}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={busy || !input.trim() || !configured}>
            {busy ? t("assistant.stop") : t("assistant.send")}
          </Button>
          {busy && (
            <Button variant="outline" onClick={() => abortRef.current?.abort()}>
              {t("assistant.stop")}
            </Button>
          )}
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
            <Button variant="outline" className="w-full justify-start" onClick={newThread}>
              + {t("assistant.newThread")}
            </Button>
            {threads.length === 0 && (
              <p className="px-1 py-3 text-sm text-muted-foreground">{t("assistant.noHistory")}</p>
            )}
            {threads.map((th) => (
              <button
                key={th.id}
                type="button"
                onClick={() => selectThread(th.id)}
                className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  th.id === threadId ? "bg-accent font-medium" : ""
                }`}
              >
                {th.title}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{t("assistant.settings.title")}</SheetTitle>
            <SheetDescription>{t("assistant.settings.desc")}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">{settingsPanel}</div>
        </SheetContent>
      </Sheet>

      {pendingPanel && (
        <Sheet open={pendingOpen} onOpenChange={setPendingOpen}>
          <SheetContent side="right" className="overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{t("actions.title")}</SheetTitle>
              <SheetDescription>{t("actions.desc")}</SheetDescription>
            </SheetHeader>
            <div className="mt-4 space-y-3">
              {pendingPanel}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
