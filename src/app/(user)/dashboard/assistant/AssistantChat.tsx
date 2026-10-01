"use client";

/**
 * app/(user)/dashboard/assistant/AssistantChat.tsx
 *
 * The chat surface. Reads the SSE stream from `/api/assistant/chat` and renders
 * text as it arrives.
 *
 * Two details worth knowing:
 *
 *  - The caller's gateway key is held in component state and attached per
 *    request, never stored. It only matters for the assistant's
 *    `test_gateway_model` tool; without it that tool reports that it cannot
 *    test, which is the honest answer.
 *  - `fetch` is used rather than `EventSource` because the request carries a
 *    body and an auth header, which EventSource cannot do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
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

export function AssistantChat({ configured }: { configured: boolean }) {
  const t = useT();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (threadId) void loadThread(threadId);
    else setMessages([]);
  }, [threadId, loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function newThread() {
    const res = await fetch("/api/assistant/threads", { method: "POST" });
    const json = (await res.json().catch(() => null)) as { data?: { thread?: Thread } } | null;
    if (json?.data?.thread) {
      setThreadId(json.data.thread.id);
      setMessages([]);
      setError(null);
      void loadThreads();
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setInput("");

    // Show the user's turn immediately; the server has already persisted it, so
    // a failed stream does not lose the message.
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text },
    ]);
    setMessages((prev) => [...prev, { id: "streaming", role: "assistant", content: "" }]);

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

      // The server may have created a thread on this first turn; adopt its id
      // so the next message continues the same conversation.
      const created = res.headers.get("x-assistant-thread");
      if (created) setThreadId(created);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const appendToStreaming = (chunk: string) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === "streaming" ? { ...m, content: m.content + chunk } : m)),
        );
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
            appendToStreaming(evt.text);
          } else if (evt.type === "error" && evt.text) {
            setError(evt.text);
          } else if (evt.type === "done" && evt.data?.pendingActions?.length) {
            setPending(evt.data.pendingActions);
            router.refresh();
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Stopped by the user; whatever streamed so far is kept.
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      // Replace the streaming placeholder with a real id so subsequent updates
      // do not keep appending to a row the reload will replace anyway.
      setMessages((prev) =>
        prev.map((m, i) => (m.id === "streaming" && i === prev.length - 1 ? { ...m, id: `a-${Date.now()}` } : m)),
      );
      if (threadId) void loadThread(threadId);
      else void loadThreads();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      {/*
        Wide: a column of conversations beside the chat.
        Narrow: the same list as a horizontal strip. Left as a stacked
        column it pushed the conversation itself off the bottom of a phone
        screen, which is the one thing the page exists to show.
      */}
      <div className="space-y-2 lg:max-h-[calc(100vh-16rem)] lg:overflow-y-auto">
        <Button onClick={newThread} className="w-full" variant="outline">
          {t("assistant.newThread")}
        </Button>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:block lg:space-y-1 lg:overflow-visible lg:px-0 lg:pb-0">
          {threads.map((th) => (
            <button
              key={th.id}
              type="button"
              onClick={() => setThreadId(th.id)}
              className={`block max-w-[16rem] shrink-0 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent lg:w-full lg:max-w-none ${
                th.id === threadId ? "bg-accent font-medium" : ""
              }`}
              title={th.title}
            >
              {th.title}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {!configured && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {t("assistant.notConfigured")}
          </div>
        )}

        <div className="space-y-3 rounded-md border border-border p-3">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("assistant.emptyState")}</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {m.role === "user" ? t("assistant.you") : m.role === "tool" ? `⚙ ${m.toolName ?? "tool"}` : "AI"}
              </p>
              {m.role === "tool" ? (
                <details className="rounded bg-muted/40 p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t("assistant.toolResult")}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {m.content}
                  </pre>
                </details>
              ) : (
                <p
                  className={`whitespace-pre-wrap break-words text-sm ${
                    m.role === "assistant" ? "" : "text-muted-foreground"
                  }`}
                >
                  {m.content}
                </p>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error && (
          <pre className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </pre>
        )}

        {pending.length > 0 && (
          <p className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
            {t("assistant.pendingAction")}
          </p>
        )}

        <Input
          label={t("assistant.gatewayKey")}
          hint={t("assistant.gatewayKeyHint")}
          type="password"
          autoComplete="off"
          placeholder="sk-relay-..."
          value={relayKey}
          onChange={(e) => setRelayKey(e.target.value)}
        />

        <div className="space-y-1.5">
          <label htmlFor="assistant-input" className="block text-sm font-medium text-foreground">
            {t("assistant.placeholder")}
          </label>
          <textarea
            id="assistant-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={send} disabled={busy || !input.trim() || !configured}>
            {busy ? t("assistant.thinking") : t("assistant.send")}
          </Button>
          {busy && (
            <Button
              variant="outline"
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              {t("assistant.stop")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
