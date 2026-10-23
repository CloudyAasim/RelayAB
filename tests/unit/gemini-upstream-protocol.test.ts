/**
 * tests/unit/gemini-upstream-protocol.test.ts
 *
 * The two conversions that make a Gemini vendor reachable: the pivot's request
 * into Gemini's shape, and Gemini's answer back into the pivot's.
 *
 * These are the parts worth pinning on their own, because the end-to-end test
 * can only show one path through them: what a message becomes, what a tool
 * becomes, and — the one that decides whether a client believes it — what a
 * finish reason means.
 */
import { describe, it, expect } from "vitest";
import {
  responsesToGeminiRequest,
  geminiToResponsesResponse,
} from "@/lib/protocol/gemini";

describe("the pivot's request, in Gemini's shape", () => {
  it("is a user turn with one part", () => {
    expect(responsesToGeminiRequest({ input: "hi" })).toEqual({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
  });

  it("calls the assistant 'model', as Gemini does", () => {
    const gemini = responsesToGeminiRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
    });
    expect(gemini.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });

  it("merges two turns in a row, because Gemini has no such thing", () => {
    // The pivot has no opinion about alternating roles and Gemini does, so two
    // user turns have to become one turn as far as the vendor is concerned.
    const gemini = responsesToGeminiRequest({
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "user", content: [{ type: "input_text", text: "second" }] },
      ],
    });
    expect(gemini.contents).toEqual([
      { role: "user", parts: [{ text: "first" }, { text: "second" }] },
    ]);
  });

  it("carries the system prompt in Gemini's own field", () => {
    const gemini = responsesToGeminiRequest({ input: "hi", instructions: "be brief" });
    expect(gemini.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
  });

  it("moves the generation knobs across", () => {
    const gemini = responsesToGeminiRequest({
      input: "hi",
      temperature: 0.4,
      top_p: 0.9,
      max_output_tokens: 512,
      stop: ["END"],
    });
    expect(gemini.generationConfig).toEqual({
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 512,
      stopSequences: ["END"],
    });
  });

  it("turns a thinking budget of zero into Gemini's 'do not think'", () => {
    expect(
      responsesToGeminiRequest({ input: "hi", reasoning: { effort: "none" } }).generationConfig,
    ).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it("turns a structured-output request into Gemini's own two fields", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const gemini = responsesToGeminiRequest({
      input: "hi",
      text: { format: { type: "json_schema", name: "response", schema, strict: true } },
    });
    expect(gemini.generationConfig?.responseMimeType).toBe("application/json");
    expect(gemini.generationConfig?.responseSchema).toEqual(schema);
  });

  it("turns the flat tool list into Gemini's declarations", () => {
    const gemini = responsesToGeminiRequest({
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      tool_choice: "required",
    });
    expect(gemini.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "the weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
      },
    ]);
    expect(gemini.toolConfig?.functionCallingConfig?.mode).toBe("ANY");
  });

  it("carries a tool call and its answer across", () => {
    const gemini = responsesToGeminiRequest({
      input: [
        { type: "function_call", call_id: "c1", name: "get_weather", arguments: '{"city":"北京"}' },
        { type: "function_call_output", call_id: "c1", output: "sunny" },
      ],
    });
    expect(gemini.contents).toEqual([
      {
        role: "model",
        parts: [{ functionCall: { name: "get_weather", args: { city: "北京" }, id: "c1" } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "c1", response: { output: "sunny" } } }],
      },
    ]);
  });

  it("inlines an image that carries its bytes", () => {
    const gemini = responsesToGeminiRequest({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: "data:image/png;base64,AAAB" },
          ],
        },
      ],
    });
    expect(gemini.contents?.[0].parts).toEqual([
      { text: "what is this" },
      { inlineData: { mimeType: "image/png", data: "AAAB" } },
    ]);
  });

  it("drops a remote image, because Gemini has nowhere to put it", () => {
    // `fileData` only takes a Files API or GCS URI; an arbitrary address is
    // not something Gemini can read, and sending it would be refused.
    const gemini = responsesToGeminiRequest({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: "https://example.test/a.png" },
          ],
        },
      ],
    });
    expect(gemini.contents?.[0].parts).toEqual([{ text: "what is this" }]);
  });
});

describe("Gemini's answer, in the pivot's shape", () => {
  const answer = (finishReason: string) => ({
    candidates: [
      {
        content: { role: "model", parts: [{ text: "hello there" }] },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30, totalTokenCount: 42 },
    modelVersion: "gemini-2.5-flash",
  });

  it("becomes a message and the text beside it", () => {
    const pivot = geminiToResponsesResponse(answer("STOP"), "client-m");
    expect(pivot.output_text).toBe("hello there");
    expect(pivot.output).toEqual([
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello there", annotations: [] }],
      },
    ]);
  });

  it("says completed when the model finished", () => {
    expect(geminiToResponsesResponse(answer("STOP"), "client-m").status).toBe("completed");
  });

  it("says incomplete when it was cut off", () => {
    // The one that matters: "completed" would tell the client it has the whole
    // answer when it has half of one.
    const pivot = geminiToResponsesResponse(answer("MAX_TOKENS"), "client-m");
    expect(pivot.status).toBe("incomplete");
    expect(pivot.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  it("says failed when the answer was blocked", () => {
    // A safety block is not a truncation: there is no answer to continue.
    const pivot = geminiToResponsesResponse(answer("SAFETY"), "client-m");
    expect(pivot.status).toBe("failed");
    expect(pivot.error).not.toBeNull();
  });

  it("counts the tokens the way the pivot counts them", () => {
    expect(geminiToResponsesResponse(answer("STOP"), "client-m").usage).toEqual({
      input_tokens: 12,
      output_tokens: 30,
      total_tokens: 42,
    });
  });

  it("carries the cached slice of the prompt", () => {
    const pivot = geminiToResponsesResponse(
      {
        ...answer("STOP"),
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 30,
          totalTokenCount: 42,
          cachedContentTokenCount: 8,
        },
      },
      "client-m",
    );
    expect((pivot.usage as Record<string, unknown>).input_tokens_details).toEqual({
      cached_tokens: 8,
    });
  });

  it("carries a tool call across", () => {
    const pivot = geminiToResponsesResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "北京" }, id: "c1" } }],
            },
            finishReason: "STOP",
          },
        ],
      },
      "client-m",
    );
    expect(pivot.output).toEqual([
      {
        type: "function_call",
        call_id: "c1",
        name: "get_weather",
        arguments: '{"city":"北京"}',
      },
    ]);
  });

  it("keeps the model's own reasoning apart from its answer", () => {
    const pivot = geminiToResponsesResponse(
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: "thinking out loud", thought: true },
                { text: "the answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
      "client-m",
    );
    expect(pivot.output_text).toBe("the answer");
    expect((pivot.output as unknown[])[0]).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking out loud" }],
    });
  });
});
