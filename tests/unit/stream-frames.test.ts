/**
 * tests/unit/stream-frames.test.ts
 *
 * The frames a stream is made of: read out of four dialects, written back in
 * one.
 *
 * The four dialects agree on what a stream is and disagree on everything else
 * — the field names, the event names, where the usage turns up, and whether
 * the last frame says "I am done". One reader for all of them is the whole
 * point of this file's subject: a reader that knew four vocabularies would
 * have to be right about all of them, and the dialects disagree about exactly
 * the places where being wrong is invisible until a client hangs.
 */
import { describe, it, expect } from "vitest";
import {
  readStreamFacts,
  pivotFrameMapper,
  chatFrameMapper,
} from "@/lib/protocol/stream-frames";

/** The payload of an SSE `data:` line, parsed. */
function payloadOf(frame: string): Record<string, unknown> {
  const data = frame
    .split("\n")
    .find((line) => line.startsWith("data:"));
  return JSON.parse(String(data).slice(5).trim());
}

describe("reading a frame of any dialect", () => {
  it("reads a Responses delta", () => {
    const facts = readStreamFacts({
      type: "response.output_text.delta",
      delta: "hello",
    });
    expect(facts.text).toBe("hello");
  });

  it("reads a Chat chunk", () => {
    const facts = readStreamFacts({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });
    expect(facts.text).toBe("hello");
    expect(facts.id).toBe("chatcmpl-1");
    expect(facts.end).toBeFalsy();
  });

  it("reads the usage frame a Chat upstream sends on its own", () => {
    // It is a frame with no choices at all — the shape a vendor sends when it
    // was asked for the usage and nothing else.
    const facts = readStreamFacts({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(facts.inputTokens).toBe(10);
    expect(facts.outputTokens).toBe(5);
  });

  it("reads an Anthropic delta", () => {
    const facts = readStreamFacts({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    });
    expect(facts.text).toBe("hello");
  });

  it("reads the two halves of the Anthropic usage", () => {
    // Anthropic reports the input tokens on `message_start` and the output
    // tokens on `message_delta`, so a reader that only looked at one frame
    // would bill half of every turn.
    const start = readStreamFacts({
      type: "message_start",
      message: { id: "msg_1", model: "claude", usage: { input_tokens: 12 } },
    });
    expect(start.inputTokens).toBe(12);
    expect(start.id).toBe("msg_1");

    const delta = readStreamFacts({ type: "message_delta", usage: { output_tokens: 30 } });
    expect(delta.outputTokens).toBe(30);
  });

  it("reads a Gemini chunk", () => {
    const facts = readStreamFacts({
      candidates: [
        { content: { role: "model", parts: [{ text: "hello" }] }, index: 0, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30 },
      modelVersion: "gemini-2.5-flash",
    });
    expect(facts.text).toBe("hello");
    expect(facts.inputTokens).toBe(12);
    expect(facts.outputTokens).toBe(30);
    expect(facts.end).toBe(true);
    expect(facts.model).toBe("gemini-2.5-flash");
  });

  it("does not mistake a thought for the answer", () => {
    const facts = readStreamFacts({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "thinking out loud", thought: true }, { text: "the answer" }],
          },
        },
      ],
    });
    expect(facts.text).toBe("the answer");
  });

  it("says nothing about a frame it does not understand", () => {
    expect(readStreamFacts({ hello: "world" })).toEqual({});
    expect(readStreamFacts(null)).toEqual({});
  });
});

describe("writing the pivot's frames", () => {
  it("turns a Chat chunk into a Responses delta", () => {
    const mapper = pivotFrameMapper("client-m");
    const out = mapper.map(
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"}}]}',
    );
    expect(out).not.toBeNull();
    const lines = out as string[];
    expect(lines[0]).toBe("event: response.output_text.delta");
    expect(payloadOf(lines.join("\n"))).toEqual({
      type: "response.output_text.delta",
      delta: "hello",
    });
  });

  it("turns an Anthropic event and a Gemini chunk into the same delta", () => {
    const anthropic = pivotFrameMapper("client-m").map(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
    );
    const gemini = pivotFrameMapper("client-m").map(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"index":0}]}',
    );
    expect(payloadOf((anthropic as string[]).join("\n"))).toEqual(
      payloadOf((gemini as string[]).join("\n")),
    );
  });

  it("writes the closing frame with the usage the upstream reported", () => {
    const mapper = pivotFrameMapper("client-m");
    mapper.map(
      'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}',
    );
    // The usage frame comes *after* the chunk that carries the finish reason,
    // which is why the closing frame is written at the end and not there.
    mapper.map('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}');
    const out = mapper.onEnd() as string[];
    const payload = payloadOf(out.join("\n")) as {
      type: string;
      response: { usage: Record<string, number> };
    };
    expect(payload.type).toBe("response.completed");
    expect(payload.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });

  it("drops the frames that carry nothing", () => {
    const mapper = pivotFrameMapper("client-m");
    expect(mapper.map("event: message_start")).toBeNull();
    expect(mapper.map("data: [DONE]")).toBeNull();
    expect(mapper.map("data: {not json")).toBeNull();
  });
});

describe("writing Chat chunks", () => {
  it("turns a Responses delta into a Chat chunk", () => {
    const mapper = chatFrameMapper("client-m");
    const out = mapper.map(
      'data: {"type":"response.output_text.delta","delta":"hello"}',
    );
    const payload = payloadOf(String(out)) as {
      object: string;
      choices: Array<{ delta: { content: string }; finish_reason: string | null }>;
    };
    expect(payload.object).toBe("chat.completion.chunk");
    expect(payload.choices[0].delta.content).toBe("hello");
    expect(payload.choices[0].finish_reason).toBeNull();
  });

  it("closes with the finish reason, the usage and [DONE]", () => {
    const mapper = chatFrameMapper("client-m");
    mapper.map('data: {"type":"response.output_text.delta","delta":"hello"}');
    const out = mapper.onEnd() as string[];
    expect(out).toHaveLength(3);

    const closing = payloadOf(out[0]) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(closing.choices[0].finish_reason).toBe("stop");

    const usage = payloadOf(out[1]) as {
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(usage.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

    expect(out[2]).toBe("data: [DONE]");
  });

  it("closes only once, whatever ends the stream", () => {
    // The completed frame carries the closing frames with it, so the end of
    // the stream must not write them a second time — a client that reads two
    // `[DONE]`s is a client that hangs.
    const mapper = chatFrameMapper("client-m");
    const fromFrame = mapper.map(
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}',
    );
    expect(fromFrame).toHaveLength(3);
    expect(mapper.onEnd()).toEqual([]);

    // And a stream that ends without one still gets its closing frames.
    const other = chatFrameMapper("client-m");
    expect(other.onEnd()).toHaveLength(3);
  });
});
