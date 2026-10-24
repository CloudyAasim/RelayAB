/**
 * src/lib/realtime/session.ts
 *
 * One Realtime session: the conversation, the events, and the one place where
 * a Realtime turn becomes a Responses request.
 *
 * ## Why a session and not a handler
 *
 * The Realtime protocol is a conversation, not a call. The client sends items
 * over time, asks for a response, cancels it, changes the session's
 * instructions — and all of that has to survive between the events that carry
 * it. So the state lives here, in an object with a lifetime, rather than in the
 * route that happens to be handling the socket.
 *
 * ## The turn
 *
 * `response.create` is the only event that costs anything. It turns the
 * conversation into a Responses request, hands it to the pivot
 * ({@link proxyResponsesViaDialect}), and reads the answer back as the pivot's
 * frames — which are Responses frames whatever the upstream spoke. Each frame
 * becomes the Realtime event the client is waiting for, and the closing frame
 * carries the usage.
 *
 * The settlement is not this module's business: the proxy's own stream tap
 * settles the usage when the upstream's stream ends, whether that is because
 * the answer was complete, because the client went away, or because the turn
 * was aborted. This module only reads.
 *
 * ## Audio
 *
 * The bridge speaks text. The events that exist only for audio are answered
 * with an explicit error, because a client that sent audio and heard nothing
 * back cannot tell a silent model from a broken gateway.
 */

import { proxyResponsesViaDialect } from "../proxy/pivot";
import type { ProxyDeps, ProxyResult } from "../proxy/types";
import type { ApiKey, Provider, User } from "../db/types";
import {
  contentPartAdded,
  contentPartDone,
  conversationItemCreated,
  conversationItemDeleted,
  conversationItemTruncated,
  errorEvent,
  outputItemAdded,
  outputItemDone,
  outputTextDelta,
  outputTextDone,
  parseClientEvent,
  pong,
  responseCreated,
  responseDone,
  responsesRequestFrom,
  sessionCreated,
  sessionUpdated,
  usageFromResponsesEvent,
  type ParsedClientEvent,
  type RealtimeItem,
  type RealtimeSessionState,
  type RealtimeUsage,
} from "./protocol";

/** How a provider for a (possibly changed) model was resolved. */
export interface RealtimeResolution {
  ok: boolean;
  provider?: Provider;
  error?: { code: string; message: string };
}

export interface RealtimeSessionOptions {
  apiKey: ApiKey;
  user: User;
  provider: Provider;
  /** The model the client asked for, in the client's spelling. */
  model: string;
  /** The session id the client sees. */
  sessionId: string;
  /** Send one event to the client. */
  send: (event: Record<string, unknown>) => void;
  /**
   * Resolve the provider for a model.
   *
   * Needed because a client may switch the model mid-session, and a model is
   * not a provider: the row that serves it is looked up again, because the key
   * may not be allowed to use the new one.
   */
  resolve?: (model: string) => Promise<RealtimeResolution>;
  /** Overrides for the upstream call. Tests use it; production does not. */
  deps?: ProxyDeps;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One Realtime session.
 *
 * The class is deliberately small and holds no I/O of its own: everything that
 * leaves the session goes through `send`, and everything that enters it goes
 * through {@link handleEvent}. That is what makes it testable without a
 * socket.
 */
export class RealtimeSession {
  private readonly options: RealtimeSessionOptions;
  private state: RealtimeSessionState;
  private provider: Provider;
  /** The turn in flight, if any. */
  private inFlight: AbortController | null = null;
  /** The promise of the turn in flight, so a caller can wait for it. */
  private turn: Promise<void> | null = null;
  /** Set when the client asked for the turn to stop. */
  private cancelled = false;

  constructor(options: RealtimeSessionOptions) {
    this.options = options;
    this.provider = options.provider;
    this.state = {
      id: options.sessionId,
      model: options.model,
      instructions: "",
      // Text is what this bridge serves, so it is what the session says it
      // serves. A client that asked for audio gets an error and still sees
      // this.
      modalities: ["text"],
      voice: null,
      items: [],
    };
  }

  /** The session as the client sees it. */
  get snapshot(): RealtimeSessionState {
    return this.state;
  }

  /** The `session.created` event, sent once the session is established. */
  greet(): void {
    this.options.send(sessionCreated(this.state));
  }

  /**
   * Read one client event and act on it.
   *
   * `raw` is the text of one WebSocket text frame.
   */
  async handleRaw(raw: string): Promise<void> {
    await this.handleEvent(parseClientEvent(raw));
  }

  /** Act on one already-read client event. */
  async handleEvent(event: ParsedClientEvent): Promise<void> {
    switch (event.kind) {
      case "session.update":
        await this.applySessionUpdate(event);
        return;
      case "conversation.item.create": {
        const item: RealtimeItem = {
          ...event.item,
          id: event.item.id || randomId("item"),
        };
        this.state.items.push(item);
        this.options.send(conversationItemCreated(item));
        return;
      }
      case "conversation.item.delete": {
        this.state.items = this.state.items.filter((i) => i.id !== event.itemId);
        this.options.send(conversationItemDeleted(event.itemId));
        return;
      }
      case "conversation.item.truncate": {
        // The truncation point is given in milliseconds of audio, and there is
        // no audio here — so the text is kept whole and the event is
        // acknowledged. Cutting the text at an unknown character would be a
        // guess, and a guess that silently removes half an answer is worse
        // than keeping it.
        this.options.send(conversationItemTruncated(event.itemId, event.contentIndex));
        return;
      }
      case "response.create":
        // The turn is started, not awaited: the client stays free to send
        // `response.cancel` (or another event) while the answer is still being
        // produced, and a cancel that had to wait for the answer to finish
        // would be a cancel that never cancels anything.
        this.turn = this.runResponse({
          ...(event.instructions !== undefined ? { instructions: event.instructions } : {}),
          ...(event.input !== undefined ? { input: event.input } : {}),
        });
        return;
      case "response.cancel":
        this.cancelled = true;
        this.inFlight?.abort();
        return;
      case "ping":
        this.options.send(pong(event.eventId));
        return;
      case "unsupported":
        this.options.send(errorEvent("invalid_request_error", "unsupported_event", event.message));
        return;
      case "invalid":
        this.options.send(errorEvent("invalid_request_error", event.code, event.message));
        return;
    }
  }

  /** Whether a turn is being produced right now. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Wait for the turn in flight to finish.
   *
   * The turn runs on its own so that a cancel can arrive while it is running;
   * this is how a caller (a test, or the route shutting the session down)
   * waits for it to be over.
   */
  async drain(): Promise<void> {
    await this.turn;
  }

  /** Stop the turn in flight, if any. */
  abort(): void {
    this.cancelled = true;
    this.inFlight?.abort();
  }

  private async applySessionUpdate(
    event: Extract<ParsedClientEvent, { kind: "session.update" }>,
  ): Promise<void> {
    if (event.model && event.model !== this.state.model) {
      const resolved = this.options.resolve ? await this.options.resolve(event.model) : null;
      if (!resolved || !resolved.ok || !resolved.provider) {
        this.options.send(
          errorEvent(
            "invalid_request_error",
            resolved?.error?.code ?? "model_not_mapped",
            resolved?.error?.message ?? `No provider configured for model '${event.model}'`,
          ),
        );
        return;
      }
      this.provider = resolved.provider;
      this.state.model = event.model;
    }

    if (event.instructions !== undefined) this.state.instructions = event.instructions;
    if (event.voice !== undefined) this.state.voice = event.voice;

    if (event.modalities !== undefined) {
      const wantsAudio = event.modalities.some((m) => m === "audio");
      if (wantsAudio) {
        this.options.send(
          errorEvent(
            "invalid_request_error",
            "unsupported_modality",
            "This gateway's realtime bridge speaks text only; the audio modality is not served",
          ),
        );
      }
      this.state.modalities = ["text"];
    }

    this.options.send(sessionUpdated(this.state));
  }

  /**
   * Produce one response.
   *
   * The events are sent in the order a Realtime client expects them: the
   * response exists, then the item, then the part, then the text as it
   * arrives, then the part and the item are closed, and finally the response
   * itself — which is the event that carries the usage.
   */
  private async runResponse(overrides?: { instructions?: string; input?: string }): Promise<void> {
    if (this.inFlight) {
      this.options.send(
        errorEvent(
          "invalid_request_error",
          "response_in_progress",
          "A response is already in progress",
        ),
      );
      return;
    }

    const controller = new AbortController();
    this.inFlight = controller;
    this.cancelled = false;

    const responseId = randomId("resp");
    const itemId = randomId("item");
    let text = "";

    try {
      this.options.send(responseCreated(responseId, this.state.model));
      this.options.send(outputItemAdded(responseId, itemId));
      this.options.send(contentPartAdded(responseId, itemId));

      const req = responsesRequestFrom(this.state, overrides);
      const result = await proxyResponsesViaDialect({
        req,
        provider: this.provider,
        apiKey: this.options.apiKey,
        user: this.options.user,
        signal: controller.signal,
        ...(this.options.deps ? { deps: this.options.deps } : {}),
      });

      if (!result.ok) {
        this.options.send(
          errorEvent(
            "server_error",
            result.error?.code ?? "upstream_error",
            result.error?.message ?? "The upstream request failed",
          ),
        );
        this.options.send(responseDone(responseId, this.state.model, null, "failed"));
        return;
      }

      const usage = await this.pump(result, responseId, itemId, (chunk) => {
        text += chunk;
      });

      this.options.send(outputTextDone(responseId, itemId, text));
      this.options.send(contentPartDone(responseId, itemId, text));
      this.options.send(outputItemDone(responseId, itemId, text));
      this.options.send(
        responseDone(
          responseId,
          this.state.model,
          usage,
          this.cancelled ? "cancelled" : "completed",
        ),
      );

      // The answer joins the conversation, so the next turn has the context.
      if (text) {
        this.state.items.push({ id: itemId, role: "assistant", text });
      }
    } catch (err) {
      if (this.cancelled) {
        this.options.send(responseDone(responseId, this.state.model, null, "cancelled"));
        return;
      }
      this.options.send(errorEvent("server_error", "upstream_error", String(err)));
      this.options.send(responseDone(responseId, this.state.model, null, "failed"));
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Read the pivot's frames and turn them into Realtime events.
   *
   * The pivot speaks Responses frames whatever the upstream spoke, so there is
   * one shape to read: a text delta and a closing frame with the usage.
   */
  private async pump(
    result: ProxyResult,
    responseId: string,
    itemId: string,
    onText: (chunk: string) => void,
  ): Promise<RealtimeUsage | null> {
    if (!result.body) {
      // A buffered answer: one delta with the whole text.
      const data = asRecord(result.data);
      const text = typeof data?.output_text === "string" ? data.output_text : "";
      if (text) {
        this.options.send(outputTextDelta(responseId, itemId, text));
        onText(text);
      }
      return usageFromResponsesEvent({ response: data });
    }

    const reader = result.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let usage: RealtimeUsage | null = null;

    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const record = asRecord(event);
      const type = typeof record?.type === "string" ? record.type : "";
      if (type === "response.output_text.delta") {
        const delta = record?.delta;
        if (typeof delta === "string" && delta) {
          this.options.send(outputTextDelta(responseId, itemId, delta));
          onText(delta);
        }
        return;
      }
      if (type === "response.completed") {
        usage = usageFromResponsesEvent(event);
      }
    };

    try {
      for (;;) {
        const result_read = await reader.read();
        if (result_read.done) break;
        pending += decoder.decode(result_read.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);
    } finally {
      // The stream is read to the end, so the proxy's tap settles the usage.
      // A cancelled read settles it too — either way it happens once.
      try {
        await reader.cancel();
      } catch {
        /* the source may already be gone */
      }
    }

    return usage;
  }
}
