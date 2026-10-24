/**
 * tests/unit/realtime-protocol.test.ts
 *
 * The Realtime protocol, read and written.
 *
 * These are the pure parts: what a client event means, what a session says
 * about itself, what a conversation turns into, and what the server's events
 * look like. They are tested without a socket because a frame of bytes is not
 * the interesting part — the vocabulary is.
 */
import { describe, it, expect } from "vitest";
import {
  conversationItemCreated,
  errorEvent,
  outputTextDelta,
  parseClientEvent,
  pong,
  responseDone,
  responsesRequestFrom,
  sessionPayload,
  usageFromResponsesEvent,
  type RealtimeSessionState,
} from "@/lib/realtime/protocol";

const state: RealtimeSessionState = {
  id: "rt_1",
  model: "MiniMax-M3",
  instructions: "be brief",
  modalities: ["text"],
  voice: null,
  items: [{ id: "item_1", role: "user", text: "hello" }],
};

describe("reading a client event", () => {
  it("reads a session update", () => {
    const event = parseClientEvent(
      JSON.stringify({
        type: "session.update",
        session: { instructions: "be brief", modalities: ["text"], voice: "alloy" },
      }),
    );
    expect(event).toEqual({
      kind: "session.update",
      instructions: "be brief",
      modalities: ["text"],
      voice: "alloy",
    });
  });

  it("reads the text of an item, whatever the part is called", () => {
    // The protocol spells a text part `input_text` in one place and `text` in
    // another, and a client that sends `output_text` is not being unreasonable.
    for (const type of ["input_text", "text", "output_text"]) {
      const event = parseClientEvent(
        JSON.stringify({
          type: "conversation.item.create",
          item: { role: "user", content: [{ type, text: "hi" }] },
        }),
      );
      expect(event).toMatchObject({ kind: "conversation.item.create" });
      if (event.kind !== "conversation.item.create") throw new Error("unreachable");
      expect(event.item.text).toBe("hi");
      expect(event.item.role).toBe("user");
    }
  });

  it("reads the assistant's role as the assistant's role", () => {
    const event = parseClientEvent(
      JSON.stringify({
        type: "conversation.item.create",
        item: { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      }),
    );
    if (event.kind !== "conversation.item.create") throw new Error("unreachable");
    expect(event.item.role).toBe("assistant");
  });

  it("reads a delete, a truncate and a cancel", () => {
    expect(
      parseClientEvent(JSON.stringify({ type: "conversation.item.delete", item_id: "i1" })),
    ).toEqual({ kind: "conversation.item.delete", itemId: "i1" });
    expect(
      parseClientEvent(
        JSON.stringify({ type: "conversation.item.truncate", item_id: "i1", content_index: 2 }),
      ),
    ).toEqual({ kind: "conversation.item.truncate", itemId: "i1", contentIndex: 2 });
    expect(parseClientEvent(JSON.stringify({ type: "response.cancel" }))).toEqual({
      kind: "response.cancel",
    });
  });

  it("reads a response request, with and without an override", () => {
    expect(parseClientEvent(JSON.stringify({ type: "response.create" }))).toEqual({
      kind: "response.create",
    });
    expect(
      parseClientEvent(
        JSON.stringify({ type: "response.create", response: { instructions: "short", input: "hi" } }),
      ),
    ).toEqual({ kind: "response.create", instructions: "short", input: "hi" });
  });

  it("answers an audio event with an error rather than with silence", () => {
    // The audio buffer is not served. A client that sent audio and got
    // nothing back could not tell a silent model from a broken gateway.
    const event = parseClientEvent(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }),
    );
    expect(event.kind).toBe("unsupported");
    if (event.kind !== "unsupported") throw new Error("unreachable");
    expect(event.message).toContain("text only");
  });

  it("refuses what is not a Realtime event", () => {
    expect(parseClientEvent("not json").kind).toBe("invalid");
    expect(parseClientEvent("[]").kind).toBe("invalid");
    const unknown = parseClientEvent(JSON.stringify({ type: "response.mystery" }));
    expect(unknown).toMatchObject({ kind: "invalid", code: "unknown_event_type" });
  });
});

describe("the session describes itself", () => {
  it("says it serves text, because that is what comes back", () => {
    const payload = sessionPayload(state);
    expect(payload.id).toBe("rt_1");
    expect(payload.model).toBe("MiniMax-M3");
    expect(payload.modalities).toEqual(["text"]);
    expect(payload.instructions).toBe("be brief");
  });
});

describe("the conversation becomes a Responses request", () => {
  it("every item is an input message", () => {
    const request = responsesRequestFrom(state);
    expect(request.model).toBe("MiniMax-M3");
    expect(request.instructions).toBe("be brief");
    expect(request.stream).toBe(true);
    expect(request.input).toEqual([
      { type: "message", role: "user", content: "hello" },
    ]);
  });

  it("an override replaces the conversation", () => {
    const request = responsesRequestFrom(state, { input: "just this" });
    expect(request.input).toEqual([{ type: "message", role: "user", content: "just this" }]);
  });

  it("an empty conversation still asks for something", () => {
    const request = responsesRequestFrom({ ...state, items: [] });
    expect(request.input).toEqual([]);
  });
});

describe("the usage of a finished response", () => {
  it("is read out of the pivot's closing frame", () => {
    const usage = usageFromResponsesEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } },
    });
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("is null when the frame carries none", () => {
    expect(usageFromResponsesEvent({ type: "response.completed" })).toBeNull();
    expect(usageFromResponsesEvent("nonsense")).toBeNull();
  });
});

describe("the events the server sends", () => {
  it("a delta names the response, the item and the part", () => {
    expect(outputTextDelta("resp_1", "item_1", "hi")).toMatchObject({
      type: "response.output_text.delta",
      response_id: "resp_1",
      item_id: "item_1",
      delta: "hi",
    });
  });

  it("a finished response carries the usage", () => {
    const event = responseDone("resp_1", "MiniMax-M3", {
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    });
    expect(event).toMatchObject({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
      },
    });
  });

  it("a cancelled response says so", () => {
    const event = responseDone("resp_1", "MiniMax-M3", null, "cancelled");
    expect(event).toMatchObject({ response: { status: "cancelled", usage: null } });
  });

  it("an item is acknowledged in the protocol's own shape", () => {
    expect(conversationItemCreated({ id: "i1", role: "user", text: "hi" })).toMatchObject({
      type: "conversation.item.created",
      item: { id: "i1", role: "user", content: [{ type: "input_text", text: "hi" }] },
    });
  });

  it("an error names its type, its code and its message", () => {
    expect(errorEvent("invalid_request_error", "unsupported_event", "no audio")).toEqual({
      type: "error",
      error: { type: "invalid_request_error", code: "unsupported_event", message: "no audio", param: null },
    });
  });

  it("a ping is answered with a pong", () => {
    expect(pong("e1")).toEqual({ type: "pong", event_id: "e1" });
    expect(pong()).toEqual({ type: "pong" });
  });
});
