/**
 * tests/unit/gemini-surface.test.ts
 *
 * The Gemini `generateContent` surface.
 *
 * What is worth pinning: the **translation** (a Gemini request has to become
 * something the gateway can forward, and the answer has to become a Gemini
 * answer again), and the **billing** (the call is billed once, on the provider
 * that served it, however many shapes it went through on the way).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import {
  geminiToResponsesRequest,
  responsesToGeminiResponse,
} from "@/lib/protocol/gemini";
import { parseGeminiPath, proxyGeminiGenerate } from "@/lib/proxy/gemini";
import { resolveAuthHeader } from "@/lib/auth/apikey";
import type { ApiKey } from "@/lib/db/types";

async function setup(): Promise<{ key: ApiKey; userId: string }> {
  const u = await createUser({
    username: "gem-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  return { key: created.key, userId: u.id };
}

async function setupProvider(
  model: string,
  upstreamFormat: "chat" | "responses" = "chat",
): Promise<void> {
  await createProvider({
    name: "Test OpenAI",
    kind: "openai",
    apiKey: "sk-upstream-test",
    priority: 1,
    upstreamFormat,
    modelConfigs: {
      [model]: {
        clientId: model,
        upstreamId: `${model}-2024-07-18`,
        inputCost: 100,
        outputCost: 200,
      },
    },
    modelMapping: { [model]: `${model}-2024-07-18` },
  });
}

describe("the Gemini path", () => {
  it("splits the model and the method", () => {
    expect(parseGeminiPath("models/gemini-2.5-flash:generateContent")).toEqual({
      model: "gemini-2.5-flash",
      method: "generateContent",
    });
    expect(parseGeminiPath("models/gemini-2.5-flash:streamGenerateContent")).toEqual({
      model: "gemini-2.5-flash",
      method: "streamGenerateContent",
    });
  });

  it("ignores the query string", () => {
    expect(parseGeminiPath("models/gemini-2.5-flash:streamGenerateContent?alt=sse")).toEqual({
      model: "gemini-2.5-flash",
      method: "streamGenerateContent",
    });
  });

  it("refuses a path it does not serve", () => {
    expect(parseGeminiPath("models/gemini-2.5-flash")).toBeNull();
    expect(parseGeminiPath("models/gemini-2.5-flash:countTokens")).toBeNull();
    expect(parseGeminiPath("models/:generateContent")).toBeNull();
  });
});

describe("the key carriers", () => {
  it("accepts the two the Google clients use", () => {
    // The Google SDKs do not send `Authorization: Bearer` — they send the key
    // in a header of their own or in the query string.
    const header = new Request("https://x.test/v1beta/models/m:generateContent", {
      headers: { "x-goog-api-key": "sk-relay-abc" },
    });
    expect(resolveAuthHeader(header)).toBe("Bearer sk-relay-abc");

    const query = new Request("https://x.test/v1beta/models/m:generateContent?key=sk-relay-abc");
    expect(resolveAuthHeader(query)).toBe("Bearer sk-relay-abc");
  });

  it("still prefers the OpenAI carrier when both are present", () => {
    const req = new Request("https://x.test/v1beta/models/m:generateContent", {
      headers: { "x-goog-api-key": "sk-relay-goog", Authorization: "Bearer sk-relay-oai" },
    });
    expect(resolveAuthHeader(req)).toBe("Bearer sk-relay-oai");
  });
});

describe("a Gemini request, translated", () => {
  it("turns contents into input messages", () => {
    const pivot = geminiToResponsesRequest(
      {
        contents: [
          { role: "user", parts: [{ text: "hello" }] },
          { role: "model", parts: [{ text: "hi" }] },
        ],
      },
      "gemini-2.5-flash",
    );
    expect(pivot.model).toBe("gemini-2.5-flash");
    expect(pivot.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });

  it("turns the system instruction into instructions", () => {
    const pivot = geminiToResponsesRequest(
      { systemInstruction: { parts: [{ text: "be brief" }] } },
      "m",
    );
    expect(pivot.instructions).toBe("be brief");
  });

  it("moves the generation config onto the pivot", () => {
    const pivot = geminiToResponsesRequest(
      {
        generationConfig: {
          temperature: 0.4,
          topP: 0.9,
          maxOutputTokens: 512,
          stopSequences: ["END"],
        },
      },
      "m",
    );
    expect(pivot.temperature).toBe(0.4);
    expect(pivot.top_p).toBe(0.9);
    expect(pivot.max_output_tokens).toBe(512);
    expect(pivot.stop).toEqual(["END"]);
  });

  it("maps a zero thinking budget onto 'do not think'", () => {
    // The one budget that has an exact equivalent: "no thinking" is the same
    // request in either vocabulary.
    const pivot = geminiToResponsesRequest(
      { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      "m",
    );
    expect(pivot.reasoning).toEqual({ effort: "none" });
  });

  it("keeps an image as an image", () => {
    const pivot = geminiToResponsesRequest(
      {
        contents: [
          {
            role: "user",
            parts: [
              { text: "what is this" },
              { inlineData: { mimeType: "image/png", data: "AAAB" } },
            ],
          },
        ],
      },
      "m",
    );
    expect(pivot.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this" },
          { type: "input_image", image_url: "data:image/png;base64,AAAB" },
        ],
      },
    ]);
  });

  it("turns a function call into a function call item", () => {
    const pivot = geminiToResponsesRequest(
      {
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { name: "get_weather", args: { city: "Beijing" }, id: "c1" } }],
          },
        ],
      },
      "m",
    );
    expect(pivot.input).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "c1",
            name: "get_weather",
            arguments: '{"city":"Beijing"}',
          },
        ],
      },
    ]);
  });

  it("turns the function declarations into tools", () => {
    const pivot = geminiToResponsesRequest(
      {
        tools: [
          {
            functionDeclarations: [
              { name: "get_weather", description: "the weather", parameters: { type: "object" } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
      },
      "m",
    );
    expect(pivot.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "the weather",
        parameters: { type: "object" },
      },
    ]);
    expect(pivot.tool_choice).toBe("required");
  });
});

describe("an answer, translated back", () => {
  it("becomes candidates and usage", () => {
    const gemini = responsesToGeminiResponse(
      {
        id: "resp_1",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "hello there" }] },
        ],
        usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 },
      },
      "gemini-2.5-flash",
    );
    expect(gemini.candidates?.[0].content?.parts).toEqual([{ text: "hello there" }]);
    expect(gemini.candidates?.[0].content?.role).toBe("model");
    expect(gemini.candidates?.[0].finishReason).toBe("STOP");
    expect(gemini.usageMetadata).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 30,
      totalTokenCount: 42,
    });
    expect(gemini.modelVersion).toBe("gemini-2.5-flash");
  });

  it("says the model was cut off when it was", () => {
    const gemini = responsesToGeminiResponse({ status: "incomplete", output: [] }, "m");
    expect(gemini.candidates?.[0].finishReason).toBe("MAX_TOKENS");
  });

  it("carries a function call across", () => {
    const gemini = responsesToGeminiResponse(
      {
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "get_weather",
            arguments: '{"city":"Beijing"}',
          },
        ],
      },
      "m",
    );
    expect(gemini.candidates?.[0].content?.parts).toEqual([
      { functionCall: { name: "get_weather", args: { city: "Beijing" }, id: "c1" } },
    ]);
  });
});

describe("the surface, end to end", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("answers a Gemini client in Gemini's shape", async () => {
    const { key, userId } = await setup();
    await setupProvider("gemini-2.5-flash");

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "gemini-2.5-flash-2024-07-18",
            choices: [
              { index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: "gemini-2.5-flash",
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/chat/completions",
      },
    });

    expect(result.ok).toBe(true);
    const body = result.data as {
      candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    };
    expect(body.candidates[0].content.parts).toEqual([{ text: "hello there" }]);
    expect(body.usageMetadata.promptTokenCount).toBe(12);
    expect(body.usageMetadata.candidatesTokenCount).toBe(30);

    // And it was billed once, on the provider that answered.
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(12);
    expect(rows[0].completionTokens).toBe(30);
  });

  it("rewrites a Responses upstream's stream into Gemini's chunks", async () => {
    const { key, userId } = await setup();
    await setupProvider("gemini-2.5-flash", "responses");

    // The Responses API's own frames: the delta is named, and the usage
    // arrives with the completion.
    const sse = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"he"}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"llo"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}',
      "",
    ].join("\n\n");

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: "gemini-2.5-flash",
      stream: true,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/responses",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBeTruthy();
    const text = await new Response(result.body!).text();
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const texts = payloads.flatMap((p) =>
      (p.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? ""),
    );
    // The text arrives in pieces, not in one lump.
    expect(texts.join("")).toBe("hello");
    const last = payloads[payloads.length - 1];
    expect(last.candidates[0].finishReason).toBe("STOP");
    expect(last.usageMetadata.totalTokenCount).toBe(7);
  });

  it("delivers a Chat upstream's answer as a stream, in Gemini's framing", async () => {
    // A Chat Completions upstream cannot stream in the shape the pivot speaks,
    // so the answer comes back whole. It is still delivered as a stream, and
    // the framing is Gemini's.
    const { key, userId } = await setup();
    await setupProvider("gemini-2.5-flash", "chat");

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "gemini-2.5-flash-2024-07-18",
            choices: [
              { index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: "gemini-2.5-flash",
      stream: true,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/chat/completions",
      },
    });

    expect(result.ok).toBe(true);
    const text = await new Response(result.body!).text();
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const texts = payloads.flatMap((p) =>
      (p.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? ""),
    );
    expect(texts.join("")).toBe("hello there");
    // And it was billed once, like any other call.
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(12);
  });
});
