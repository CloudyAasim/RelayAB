/**
 * src/lib/realtime/protocol.ts
 *
 * The OpenAI Realtime protocol, in the shape this gateway speaks it.
 *
 * ## What the Realtime API is
 *
 * Everything else this gateway exposes is a request/response call: the client
 * sends a body and gets an answer. Realtime is not. It is a WebSocket with a
 * conversation on it: the client sends *events* ("the user said this", "now
 * answer"), the server sends *events* back ("here is the first word", "here is
 * the usage"). Both sides speak at their own pace, and the protocol is the
 * vocabulary of those events.
 *
 * ## The pivot, again
 *
 * The gateway's pivot is the Responses API, and Realtime joins it as another
 * client-facing dialect. A Realtime client says `response.create`; that becomes
 * a Responses request; the upstream answers in whatever dialect it speaks; and
 * the answer comes back as Realtime events. The same machinery that carries an
 * Anthropic client to a Chat-only vendor carries a Realtime client to a vendor
 * that has never heard of a WebSocket.
 *
 * ## What this module is
 *
 * Pure functions: how a client event is read, how a session is described, how
 * a Responses request is built out of a Realtime conversation, and how the
 * server's events are shaped. No sockets, no upstream, no database — so the
 * protocol can be read on its own and tested without a network.
 *
 * ## The one thing that is deliberately *not* here
 *
 * Audio. The Realtime API is audio-first: the client streams PCM in and gets
 * PCM out. This gateway's bridge speaks **text**: an item carries text, a
 * response produces text, and the events that exist only for audio are
 * answered with an explicit error rather than quietly dropped — a client that
 * sent audio and got silence back would have no way to tell that from a model
 * that had nothing to say.
 */

import type { ResponseAPIRequest } from "../proxy/types";

/** The error types the Realtime protocol defines. */
export type RealtimeErrorType =
  | "invalid_request_error"
  | "invalid_value_error"
  | "session_error"
  | "server_error"
  | "rate_limit_error";

/** One turn of the conversation: a role and the text it said. */
export interface RealtimeItem {
  id: string;
  role: "user" | "assistant" | "system" | "developer";
  text: string;
}

/** Everything the gateway remembers about one Realtime session. */
export interface RealtimeSessionState {
  /** The session id the client sees. */
  id: string;
  /** The model the client asked for. */
  model: string;
  /** The system prompt, in the client's spelling. */
  instructions: string;
  /**
   * What the client wants back.
   *
   * Only `text` is served. A session that asks for `audio` gets an error
   * rather than a text answer dressed up as an audio one.
   */
  modalities: string[];
  /** The voice the client picked. Carried, never used — there is no audio. */
  voice: string | null;
  /** The conversation so far. */
  items: RealtimeItem[];
}

/** A client event, read. */
export type ParsedClientEvent =
  | {
      kind: "session.update";
      instructions?: string;
      modalities?: string[];
      voice?: string | null;
      model?: string;
    }
  | { kind: "conversation.item.create"; item: RealtimeItem }
  | { kind: "conversation.item.delete"; itemId: string }
  | { kind: "conversation.item.truncate"; itemId: string; contentIndex: number }
  | { kind: "response.create"; instructions?: string; input?: string }
  | { kind: "response.cancel" }
  | { kind: "ping"; eventId?: string }
  /** A known event this gateway does not serve (the audio ones). */
  | { kind: "unsupported"; type: string; message: string }
  /** Something that is not a Realtime event at all. */
  | { kind: "invalid"; code: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The text of a content part, whatever the part is called.
 *
 * The Realtime protocol spells a text part `input_text` in one place and
 * `text` in another, and a client that sends `output_text` is not being
 * unreasonable either. All four spellings mean the same thing here.
 */
function partText(part: unknown): string {
  const record = asRecord(part);
  if (!record) return typeof part === "string" ? part : "";
  const type = str(record.type) ?? "";
  if (type === "input_audio" || type === "audio") {
    // An audio part may carry a transcript (the client's own transcription of
    // what the user said). It is text, so it is usable.
    return str(record.transcript) ?? "";
  }
  return str(record.text) ?? "";
}

/** The role of an item, normalised to the four the Responses API knows. */
function itemRole(value: unknown): RealtimeItem["role"] {
  const role = (str(value) ?? "user").toLowerCase();
  if (role === "assistant" || role === "system" || role === "developer") return role;
  return "user";
}

/**
 * Read one client event.
 *
 * Returns a value rather than throwing: a malformed event is something the
 * client gets an error *for*, and the error has to name what was wrong.
 */
export function parseClientEvent(raw: string): ParsedClientEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: "invalid", code: "invalid_json", message: "Event is not valid JSON" };
  }
  const event = asRecord(payload);
  if (!event) {
    return { kind: "invalid", code: "invalid_event", message: "Event must be a JSON object" };
  }
  const type = str(event.type) ?? "";

  switch (type) {
    case "session.update": {
      const session = asRecord(event.session) ?? {};
      const instructions = str(session.instructions);
      const model = str(session.model);
      const voice = str(session.voice);
      const modalities = Array.isArray(session.modalities)
        ? session.modalities.filter((m): m is string => typeof m === "string")
        : undefined;
      return {
        kind: "session.update",
        ...(instructions !== undefined ? { instructions } : {}),
        ...(modalities !== undefined ? { modalities } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    }

    case "conversation.item.create": {
      const item = asRecord(event.item);
      if (!item) {
        return {
          kind: "invalid",
          code: "missing_item",
          message: "conversation.item.create needs an `item`",
        };
      }
      const content = item.content;
      const text = Array.isArray(content)
        ? content.map(partText).join("")
        : partText(content);
      const itemType = str(item.type) ?? "message";
      if (itemType !== "message") {
        return {
          kind: "unsupported",
          type,
          message: `This gateway serves message items only; '${itemType}' is not supported`,
        };
      }
      return {
        kind: "conversation.item.create",
        item: {
          id: str(item.id) ?? "",
          role: itemRole(item.role),
          text,
        },
      };
    }

    case "conversation.item.delete": {
      const itemId = str(event.item_id) ?? "";
      if (!itemId) {
        return {
          kind: "invalid",
          code: "missing_item_id",
          message: "conversation.item.delete needs an `item_id`",
        };
      }
      return { kind: "conversation.item.delete", itemId };
    }

    case "conversation.item.truncate": {
      const itemId = str(event.item_id) ?? "";
      if (!itemId) {
        return {
          kind: "invalid",
          code: "missing_item_id",
          message: "conversation.item.truncate needs an `item_id`",
        };
      }
      const contentIndex = event.content_index;
      return {
        kind: "conversation.item.truncate",
        itemId,
        contentIndex: typeof contentIndex === "number" ? contentIndex : 0,
      };
    }

    case "response.create": {
      const response = asRecord(event.response) ?? {};
      const instructions = str(response.instructions);
      const input = str(response.input);
      return {
        kind: "response.create",
        ...(instructions !== undefined ? { instructions } : {}),
        ...(input !== undefined ? { input } : {}),
      };
    }

    case "response.cancel":
      return { kind: "response.cancel" };

    case "ping":
      return { kind: "ping", ...(str(event.event_id) ? { eventId: str(event.event_id) } : {}) };

    case "input_audio_buffer.append":
    case "input_audio_buffer.commit":
    case "input_audio_buffer.clear":
      return {
        kind: "unsupported",
        type,
        message:
          "This gateway's realtime bridge speaks text only; the audio buffer is not served",
      };

    default:
      return {
        kind: "invalid",
        code: "unknown_event_type",
        message: `Unknown event type '${type}'`,
      };
  }
}

/**
 * The session object the client is told about.
 *
 * The shape is the Realtime one, with the fields this gateway actually serves.
 * A field that is not served is not sent as a fiction: `modalities` says
 * `["text"]` because that is what comes back, not `["text","audio"]` because
 * the protocol has that spelling.
 */
export function sessionPayload(state: RealtimeSessionState): Record<string, unknown> {
  return {
    id: state.id,
    object: "realtime.session",
    model: state.model,
    modalities: state.modalities,
    instructions: state.instructions,
    voice: state.voice,
    input_audio_transcription: null,
    turn_detection: null,
    tools: [],
    tool_choice: "none",
    temperature: 1,
    max_response_output_tokens: "inf",
  };
}

/**
 * The Responses request a Realtime conversation turns into.
 *
 * The conversation is the `input`, the session's instructions are the
 * `instructions`, and the request streams: a Realtime client expects the
 * answer to arrive word by word, not at the end.
 */
export function responsesRequestFrom(
  state: RealtimeSessionState,
  overrides?: { instructions?: string; input?: string },
): ResponseAPIRequest {
  const input: Array<{ type: string; content: string; role: string }> = [];

  if (overrides?.input) {
    input.push({ type: "message", role: "user", content: overrides.input });
  } else {
    for (const item of state.items) {
      if (!item.text) continue;
      input.push({ type: "message", role: item.role, content: item.text });
    }
  }

  return {
    model: state.model,
    instructions: overrides?.instructions ?? state.instructions,
    input,
    stream: true,
  };
}

/** The token counts a finished response reports. */
export interface RealtimeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Read the usage out of a Responses `response.completed` event.
 *
 * The pivot's closing frame carries the usage in the Responses spelling; the
 * Realtime spelling counts the same tokens under other names.
 */
export function usageFromResponsesEvent(payload: unknown): RealtimeUsage | null {
  const event = asRecord(payload);
  if (!event) return null;
  const response = asRecord(event.response);
  const usage = asRecord(response?.usage);
  if (!usage) return null;
  const inputTokens = numberOr(usage.input_tokens, numberOr(usage.prompt_tokens, 0));
  const outputTokens = numberOr(usage.output_tokens, numberOr(usage.completion_tokens, 0));
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberOr(usage.total_tokens, inputTokens + outputTokens),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `session.created` — sent once, when the session is established. */
export function sessionCreated(state: RealtimeSessionState): Record<string, unknown> {
  return { type: "session.created", session: sessionPayload(state) };
}

/** `session.updated` — sent after a `session.update`. */
export function sessionUpdated(state: RealtimeSessionState): Record<string, unknown> {
  return { type: "session.updated", session: sessionPayload(state) };
}

/** `conversation.item.created` — the gateway's acknowledgement of an item. */
export function conversationItemCreated(item: RealtimeItem): Record<string, unknown> {
  return {
    type: "conversation.item.created",
    previous_item_id: null,
    item: {
      id: item.id,
      type: "message",
      status: "completed",
      role: item.role,
      content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text: item.text }],
    },
  };
}

/** `conversation.item.deleted`. */
export function conversationItemDeleted(itemId: string): Record<string, unknown> {
  return { type: "conversation.item.deleted", item_id: itemId };
}

/** `conversation.item.truncated`. */
export function conversationItemTruncated(
  itemId: string,
  contentIndex: number,
): Record<string, unknown> {
  return {
    type: "conversation.item.truncated",
    item_id: itemId,
    content_index: contentIndex,
    audio_end_ms: 0,
  };
}

/** `response.created` — the response exists and is being produced. */
export function responseCreated(
  responseId: string,
  model: string,
): Record<string, unknown> {
  return {
    type: "response.created",
    response: {
      id: responseId,
      object: "realtime.response",
      status: "in_progress",
      model,
      output: [],
    },
  };
}

/** `response.output_item.added` — the assistant's message is starting. */
export function outputItemAdded(
  responseId: string,
  itemId: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    response_id: responseId,
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  };
}

/** `response.content_part.added` — the text part is starting. */
export function contentPartAdded(
  responseId: string,
  itemId: string,
): Record<string, unknown> {
  return {
    type: "response.content_part.added",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  };
}

/** `response.output_text.delta` — one piece of the answer. */
export function outputTextDelta(
  responseId: string,
  itemId: string,
  delta: string,
): Record<string, unknown> {
  return {
    type: "response.output_text.delta",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta,
  };
}

/** `response.output_text.done` — the whole text of the part. */
export function outputTextDone(
  responseId: string,
  itemId: string,
  text: string,
): Record<string, unknown> {
  return {
    type: "response.output_text.done",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  };
}

/** `response.content_part.done` — the text part is finished. */
export function contentPartDone(
  responseId: string,
  itemId: string,
  text: string,
): Record<string, unknown> {
  return {
    type: "response.content_part.done",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text },
  };
}

/** `response.output_item.done` — the assistant's message is finished. */
export function outputItemDone(
  responseId: string,
  itemId: string,
  text: string,
): Record<string, unknown> {
  return {
    type: "response.output_item.done",
    response_id: responseId,
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  };
}

/**
 * `response.done` — the response is over.
 *
 * `status` says how it ended: `completed`, `cancelled` (the client asked) or
 * `failed` (the upstream did not answer). A client that only reads the status
 * still learns the truth.
 */
export function responseDone(
  responseId: string,
  model: string,
  usage: RealtimeUsage | null,
  status: "completed" | "cancelled" | "failed" = "completed",
): Record<string, unknown> {
  return {
    type: "response.done",
    response: {
      id: responseId,
      object: "realtime.response",
      status,
      model,
      output: [],
      usage: usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.totalTokens,
          }
        : null,
    },
  };
}

/** `pong` — the answer to a `ping`. */
export function pong(eventId?: string): Record<string, unknown> {
  return { type: "pong", ...(eventId ? { event_id: eventId } : {}) };
}

/** `error` — something the client has to know about. */
export function errorEvent(
  type: RealtimeErrorType,
  code: string,
  message: string,
): Record<string, unknown> {
  return { type: "error", error: { type, code, message, param: null } };
}
