/**
 * tests/unit/gemini-thinking-tokens.test.ts
 *
 * The thinking tokens are not free.
 *
 * ## Why this is worth pinning
 *
 * Google's `totalTokenCount` is `promptTokenCount + candidatesTokenCount +
 * thoughtsTokenCount` — and Google bills the thinking at the output rate. The
 * gateway used to count only `candidatesTokenCount`, so **every thinking token
 * was given away**: the turn was billed as if the model had not thought at
 * all, and the quota it drew down was computed from a number that did not
 * match the upstream's own total.
 *
 * The tell was arithmetic: the pivot reported `total_tokens` from
 * `totalTokenCount` (which includes the thinking) beside an `output_tokens`
 * that did not. `total ≠ input + output` is not a shape anyone meant to send.
 *
 * ## The four ways through
 *
 * A Gemini upstream can be reached two ways (translated through the hub, or
 * passed through), and each of those can be buffered or streaming. All four
 * settle their own usage, so all four are watched here — a fix that only
 * touched the buffered path would still hand the thinking away on every
 * streamed turn.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyGeminiGenerate } from "@/lib/proxy/gemini";
import { geminiToResponsesResponse } from "@/lib/protocol/gemini";
import { readStreamFacts } from "@/lib/protocol/stream-frames";
import { serializeRoutes } from "@/lib/protocol/surface-routes";
import type { ApiKey } from "@/lib/db/types";

const MODEL = "gemini-2.5-flash";
const UPSTREAM_MODEL = "gemini-2.5-flash-2024-07-18";

/** Prompt 10, answer 20, thinking 30 — Google's total is 60. */
const THINKING_USAGE = {
  promptTokenCount: 10,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 30,
  totalTokenCount: 60,
};

const GEMINI_ANSWER = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "hello there" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: THINKING_USAGE,
  modelVersion: UPSTREAM_MODEL,
};

async function setup(): Promise<{ key: ApiKey; userId: string }> {
  const u = await createUser({
    username: "gth-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  return { key: created.key, userId: u.id };
}

/** A Gemini upstream reached through the hub: the older columns decide. */
async function setupTranslatedProvider(): Promise<void> {
  await createProvider({
    name: "Test Google",
    kind: "openai",
    apiKey: "sk-upstream-gemini",
    priority: 1,
    upstreamFormat: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelConfigs: {
      [MODEL]: {
        clientId: MODEL,
        upstreamId: UPSTREAM_MODEL,
        inputCost: 100,
        outputCost: 200,
      },
    },
    modelMapping: { [MODEL]: UPSTREAM_MODEL },
  });
}

/** A Gemini upstream reached directly: the route table says so. */
async function setupDirectProvider(): Promise<void> {
  await createProvider({
    name: "Test Google",
    kind: "openai",
    apiKey: "sk-upstream-gemini",
    priority: 1,
    upstreamFormat: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelConfigs: {
      [MODEL]: {
        clientId: MODEL,
        upstreamId: UPSTREAM_MODEL,
        inputCost: 100,
        outputCost: 200,
      },
    },
    modelMapping: { [MODEL]: UPSTREAM_MODEL },
    surfaceRoutes: serializeRoutes({
      "openai-chat": { kind: "unsupported" },
      "openai-responses": { kind: "unsupported" },
      "anthropic-messages": { kind: "unsupported" },
      "gemini-generate": { kind: "passthrough" },
    }),
  });
}

/** The upstream's frames, with the usage on the last one. */
const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"index":0}],"modelVersion":"' +
    UPSTREAM_MODEL +
    '"}',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]},"index":0,"finishReason":"STOP"}],"usageMetadata":' +
    JSON.stringify(THINKING_USAGE) +
    ',"modelVersion":"' +
    UPSTREAM_MODEL +
    '"}',
  "",
].join("\n\n");

describe("the pivot's own shape", () => {
  it("counts the thinking with the output tokens", () => {
    const pivot = geminiToResponsesResponse(
      { candidates: [], usageMetadata: THINKING_USAGE },
      "client-m",
    );
    expect(pivot.usage).toEqual({
      input_tokens: 10,
      output_tokens: 50,
      total_tokens: 60,
    });
  });

  it("makes the total add up", () => {
    // The shape says `total_tokens` is `input + output`. Before the fix it was
    // not: the total came from the upstream (thinking included) and the output
    // did not.
    const pivot = geminiToResponsesResponse(
      { candidates: [], usageMetadata: THINKING_USAGE },
      "client-m",
    );
    const usage = pivot.usage as { input_tokens: number; output_tokens: number; total_tokens: number };
    expect(usage.input_tokens + usage.output_tokens).toBe(usage.total_tokens);
  });

  it("leaves a turn without thinking exactly as it was", () => {
    const pivot = geminiToResponsesResponse(
      {
        candidates: [],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30, totalTokenCount: 42 },
      },
      "client-m",
    );
    expect(pivot.usage).toEqual({
      input_tokens: 12,
      output_tokens: 30,
      total_tokens: 42,
    });
  });
});

describe("the frame reader", () => {
  it("counts the thinking with the output tokens", () => {
    const facts = readStreamFacts({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "hello" }] },
          index: 0,
          finishReason: "STOP",
        },
      ],
      usageMetadata: THINKING_USAGE,
    });
    expect(facts.inputTokens).toBe(10);
    expect(facts.outputTokens).toBe(50);
  });
});

describe("the turn that was billed", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("counts the thinking when the answer came through the hub", async () => {
    const { key, userId } = await setup();
    await setupTranslatedProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(GEMINI_ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(10);
    // 20 of answer + 30 of thinking. Before the fix this said 20.
    expect(rows[0].completionTokens).toBe(50);
  });

  it("counts the thinking when the answer was streamed through the hub", async () => {
    const { key, userId } = await setup();
    await setupTranslatedProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(GEMINI_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: true,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    // The stream settles when it ends, so it has to be read to the end before
    // the usage row exists.
    await new Response(result.body!).text();
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(10);
    expect(rows[0].completionTokens).toBe(50);
  });

  it("counts the thinking when the answer came straight from the vendor", async () => {
    const { key, userId } = await setup();
    await setupDirectProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(GEMINI_ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(10);
    expect(rows[0].completionTokens).toBe(50);
  });

  it("counts the thinking when the answer was streamed straight from the vendor", async () => {
    const { key, userId } = await setup();
    await setupDirectProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(GEMINI_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: true,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    await new Response(result.body!).text();
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(10);
    expect(rows[0].completionTokens).toBe(50);
  });

  it("bills the same amount whichever way the answer came back", async () => {
    // The whole point of the two paths being the same: a client must not be
    // charged differently because of how the vendor was reached.
    const translated = await setup();
    await setupTranslatedProvider();
    const translatedFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(GEMINI_ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: false,
      apiKey: translated.key,
      user: (await getUserById(translated.userId))!,
      deps: { fetchImpl: translatedFetch as unknown as typeof fetch },
    });
    const translatedRows = await listUsageByKey(translated.key.id);

    __resetDbForTest();
    const direct = await setup();
    await setupDirectProvider();
    const directFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(GEMINI_ANSWER), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: false,
      apiKey: direct.key,
      user: (await getUserById(direct.userId))!,
      deps: { fetchImpl: directFetch as unknown as typeof fetch },
    });
    const directRows = await listUsageByKey(direct.key.id);

    expect(directRows[0].completionTokens).toBe(translatedRows[0].completionTokens);
    expect(directRows[0].creditsUsed).toBe(translatedRows[0].creditsUsed);
  });
});
