/**
 * Responses → Chat Completions conversion tests.
 *
 * Regression context: a Responses client (Codex CLI) configured against
 * `/v1/responses` with a provider whose `upstreamFormat` is `chat` failed with
 *
 *   502 Bad Gateway: Upstream returned 500
 *
 * The converter copied Responses content blocks into a Chat Completions
 * `messages` array verbatim. `input_text` is a Responses-only block type, and
 * strict upstreams reject the whole request because of it — Agnes answers
 * HTTP 500 `Invalid user message at index 0`. The same converter also dropped
 * `instructions` (the system prompt) and `tools`, which silently disabled the
 * client's agent loop.
 */
import { describe, it, expect } from "vitest";
import { responsesToChatRequest, chatToResponsesResponse } from "@/lib/proxy/openai";

/** A request body shaped like the one Codex CLI sends. */
const CODEX_BODY = {
  model: "agnes-3.0-flash",
  instructions: "You are a coding agent.",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "explain this repo" }],
    },
  ],
  tools: [
    {
      type: "function",
      name: "shell",
      description: "run a shell command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high", summary: "auto" },
  store: false,
  stream: true,
};

describe("responsesToChatRequest", () => {
  it("never forwards a Responses-only content block type", () => {
    const out = responsesToChatRequest(CODEX_BODY as never);
    const serialized = JSON.stringify(out);
    for (const blockType of ["input_text", "output_text", "input_image", "refusal"]) {
      expect(serialized).not.toContain(blockType);
    }
  });

  it("collapses a single text block to a plain string", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    } as never);
    expect(out.messages).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("maps a text+image message to Chat Completions blocks", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: "https://example.com/a.png" },
          ],
        },
      ],
    } as never);
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
  });

  it("keeps the system prompt carried in instructions", () => {
    const out = responsesToChatRequest({
      model: "m",
      instructions: "You are terse.",
      input: "hi",
    } as never);
    expect(out.messages?.[0]).toEqual({ role: "system", content: "You are terse." });
    expect(out.messages?.[1]).toEqual({ role: "user", content: "hi" });
  });

  it("treats a developer message as the system prompt", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: [{ type: "message", role: "developer", content: "be brief" }],
    } as never);
    expect(out.messages).toEqual([{ role: "system", content: "be brief" }]);
  });

  it("nests flat Responses tool declarations under `function`", () => {
    const out = responsesToChatRequest(CODEX_BODY as never);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "shell",
          description: "run a shell command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      },
    ]);
  });

  it("passes through an already-nested tool declaration", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: "hi",
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    } as never);
    expect(out.tools).toEqual([
      { type: "function", function: { name: "f", parameters: { type: "object" } } },
    ]);
  });

  it("drops hosted tools that have no Chat Completions equivalent", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: "hi",
      tools: [{ type: "web_search" }],
    } as never);
    expect(out.tools).toBeUndefined();
  });

  it("replays function_call as an assistant tool_calls message", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", call_id: "call_1", output: "a.ts\nb.ts" },
      ],
    } as never);
    expect(out.messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a.ts\nb.ts" },
    ]);
  });

  it("drops reasoning items", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "message", role: "user", content: "hi" },
      ],
    } as never);
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("honours max_output_tokens and leaves the request buffered upstream", () => {
    const out = responsesToChatRequest({
      model: "m",
      input: "hi",
      max_output_tokens: 4096,
      stream: true,
    } as never);
    expect(out.max_tokens).toBe(4096);
    // The chat hop is buffered on purpose: the route replays the buffered
    // `response` object as SSE for the client.
    expect(out.stream).toBe(false);
  });

  it("still accepts a bare string input", () => {
    const out = responsesToChatRequest({ model: "m", input: "hello" } as never);
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("chatToResponsesResponse", () => {
  it("surfaces tool_calls as function_call output items", () => {
    const out = chatToResponsesResponse(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "up-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_9", type: "function", function: { name: "shell", arguments: '{"cmd":"pwd"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      { model: "agnes-3.0-flash" } as never,
    );
    expect(out.output).toEqual([
      {
        id: "fc_call_9",
        type: "function_call",
        status: "completed",
        call_id: "call_9",
        name: "shell",
        arguments: '{"cmd":"pwd"}',
      },
    ]);
    expect(out.output_text).toBe("");
  });

  it("surfaces plain text as a message output item", () => {
    const out = chatToResponsesResponse(
      {
        id: "chatcmpl-2",
        object: "chat.completion",
        created: 1,
        model: "up-model",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      { model: "m" } as never,
    );
    expect(out.output_text).toBe("hi");
    const output = out.output as Array<{ type: string; content: Array<{ text: string }> }>;
    expect(output[0].type).toBe("message");
    expect(output[0].content[0].text).toBe("hi");
  });
});
