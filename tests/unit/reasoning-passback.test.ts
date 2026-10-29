/**
 * tests/unit/reasoning-passback.test.ts
 *
 * The thinking has to come back.
 *
 * A gateway that converts between dialects is exactly where a model's own
 * reasoning gets dropped: the reasoning is part of the protocol, not a piece of
 * server-side state, and the vendors say so.
 *
 *   - **MiniMax**: "it is important to retain the thinking content from the
 *     assistant's turns within the historical messages … you must ensure that
 *     the historical content is passed back in its original format. Do not
 *     remove the `<think>` part, otherwise, the model's performance will be
 *     negatively affected."
 *   - **DeepSeek** (Responses API): "The `reasoning_text` in the thinking mode
 *     must be passed back to the API." — a 400, not a degradation.
 *
 * So the reasoning is carried across every boundary a request crosses:
 *
 *   1. a Responses client's `reasoning` item → the Chat message's
 *      `reasoning_content`, when the upstream speaks Chat Completions;
 *   2. a Chat upstream's `reasoning_content` → the Responses client's
 *      `reasoning` item, so the client has something to echo back;
 *   3. the same, through the streaming frames;
 *   4. the assistant's own transcript → the assistant turn it belongs to.
 *
 * These are behavioural tests: they call the converters and read the frames,
 * rather than matching the source. A guard that matches source text proves the
 * source says the thing; only calling it proves the wire carries it.
 */
import { describe, it, expect } from "vitest";
import { responsesToChatRequest, chatToResponsesResponse } from "@/lib/proxy/converters/chat";
import { pivotFrameMapper, chatFrameMapper } from "@/lib/protocol/stream-frames";
import { toWireMessages } from "@/lib/assistant/chat";
import type { AssistantMessage } from "@/lib/assistant/schema";

/** A Responses `input` array with one thinking turn and one tool call. */
const RESPONSES_INPUT = [
  { role: "user", content: [{ type: "input_text", text: "查一下模型列表" }] },
  { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "先问网关" }] },
  {
    type: "function_call",
    call_id: "call_1",
    name: "list_gateway_models",
    arguments: "{}",
  },
];

/** A Chat assistant message that carries the thinking beside the answer. */
const CHAT_REPLY = {
  id: "chatcmpl-1",
  model: "m",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        reasoning_content: "先问网关",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_gateway_models", arguments: "{}" },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

describe("the reasoning crosses the dialect boundary", () => {
  it("a Responses client's reasoning item reaches the Chat upstream", () => {
    const request = responsesToChatRequest({
      model: "m",
      input: RESPONSES_INPUT,
    } as never) as { messages: Record<string, unknown>[] };

    const assistant = request.messages.find((m) => m.role === "assistant");
    expect(assistant, "the tool call did not become an assistant message").toBeTruthy();
    // The old shape dropped it here, on the grounds that it was "server-side
    // state, nothing to replay" — which is the assumption every one of these
    // vendors contradicts.
    expect(
      assistant!.reasoning_content,
      "the thinking was dropped on the way to the upstream",
    ).toBe("先问网关");
  });

  it("and the shape the vendor used is the shape that is read", () => {
    // Three spellings, because the vendors do not agree: a plain
    // `reasoning_text`, a `content` array of `reasoning_text` blocks, and a
    // `summary` array. Reading only one of them is how a gateway ends up
    // carrying the reasoning for some vendors and losing it for the rest.
    const cases: Array<[string, unknown]> = [
      ["flat", { type: "reasoning", reasoning_text: "想过了" }],
      ["blocks", { type: "reasoning", content: [{ type: "reasoning_text", text: "想过了" }] }],
      ["summary", { type: "reasoning", summary: [{ type: "summary_text", text: "想过了" }] }],
    ];
    for (const [name, item] of cases) {
      const request = responsesToChatRequest({
        model: "m",
        input: [{ role: "user", content: "hi" }, item, { type: "message", role: "assistant", content: "好" }],
      } as never) as { messages: Record<string, unknown>[] };
      const assistant = request.messages.find((m) => m.role === "assistant");
      expect(assistant?.reasoning_content, `the ${name} shape was not read`).toBe("想过了");
    }
  });

  it("and the Chat upstream's thinking reaches the Responses client", () => {
    const response = chatToResponsesResponse(CHAT_REPLY as never, { model: "m" } as never);
    const output = response.output as Record<string, unknown>[];
    const reasoning = output.find((item) => item.type === "reasoning");
    expect(reasoning, "the thinking never became a reasoning item").toBeTruthy();
    expect(JSON.stringify(reasoning)).toContain("先问网关");
    // It goes first, because that is where the protocol puts it — and because
    // a client that is going to echo it back has to find it where the
    // vendor's own Responses API would have put it.
    expect(output[0].type).toBe("reasoning");
  });
});

describe("the reasoning crosses the stream", () => {
  it("a Chat upstream's thinking becomes a Responses reasoning delta", () => {
    const mapper = pivotFrameMapper("m");
    const out = mapper.map(
      `data: ${JSON.stringify({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { reasoning_content: "边想边说" } }],
      })}`,
    );
    const text = (Array.isArray(out) ? out : [out]).filter(Boolean).join("\n");
    expect(text).toContain("response.reasoning_text.delta");
    expect(text).toContain("边想边说");
  });

  it("and a Responses upstream's thinking becomes a Chat chunk's reasoning", () => {
    const mapper = chatFrameMapper("m");
    const out = mapper.map(
      `data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "边想边说" })}`,
    );
    const text = (Array.isArray(out) ? out : [out]).filter(Boolean).join("\n");
    expect(text).toContain("reasoning_content");
    expect(text).toContain("边想边说");
  });
});

describe("the assistant's own history keeps the thinking", () => {
  /** One assistant turn that thought, then called a tool. */
  const rows = [
    {
      id: "1",
      threadId: "t",
      role: "user",
      content: "查一下模型列表",
      reasoning: null,
      toolCalls: [],
      toolCallId: null,
      toolName: null,
      attachments: [],
      createdAt: "2026-10-26T00:00:00.000Z",
    },
    {
      id: "2",
      threadId: "t",
      role: "assistant",
      content: "",
      reasoning: "先问网关",
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "list_gateway_models", arguments: "{}" },
        },
      ],
      toolCallId: null,
      toolName: null,
      attachments: [],
      createdAt: "2026-10-26T00:00:01.000Z",
    },
    {
      id: "3",
      threadId: "t",
      role: "tool",
      content: "gpt-4o",
      reasoning: null,
      toolCalls: [],
      toolCallId: "call_1",
      toolName: "list_gateway_models",
      attachments: [],
      createdAt: "2026-10-26T00:00:02.000Z",
    },
  ] as unknown as AssistantMessage[];

  it("the turn that thought sends the thinking back", async () => {
    const wire = await toWireMessages(rows, "u1");
    const assistant = wire.find((m) => m.role === "assistant");
    expect(assistant, "the tool call did not become an assistant turn").toBeTruthy();
    // It was kept in the transcript all along (`assistant_messages.reasoning`)
    // and shown on screen; what it was not is *sent*. So the model read its own
    // history as if it had never thought about any of it.
    expect(
      (assistant as { reasoning_content?: string }).reasoning_content,
      "the thinking was kept but never sent back",
    ).toBe("先问网关");
  });

  it("and a turn that did not think sends nothing", async () => {
    const wire = await toWireMessages(
      rows.map((r) => ({ ...r, reasoning: null })) as AssistantMessage[],
      "u1",
    );
    const assistant = wire.find((m) => m.role === "assistant");
    expect(
      (assistant as { reasoning_content?: string }).reasoning_content,
      "a thinking was invented for a turn that had none",
    ).toBeUndefined();
  });
});
