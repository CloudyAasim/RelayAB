/**
 * tests/unit/gemini-direct-passthrough.test.ts
 *
 * The Gemini surface's direct path: a vendor that speaks Gemini answers the
 * client without anything being rewritten on the way out or on the way back.
 *
 * ## Why this is worth pinning
 *
 * "原样透传" is a promise about bytes. The other three surfaces keep it — a
 * Chat body goes to `/chat/completions` as it arrived, an Anthropic body to
 * `/v1/messages`, a Responses body to `/responses`. The Gemini surface used
 * to keep it in name only: the body was rewritten into the pivot's shape and
 * back, so "透传模式：所有接口原样透传" was not true of it.
 *
 * The fields that show the difference are the ones the pivot has no place
 * for — a thinking budget, a safety setting — and they are what these tests
 * watch. A test that only checked the text would pass on the old path too.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyGeminiGenerate } from "@/lib/proxy/gemini";
import { serializeRoutes } from "@/lib/protocol/surface-routes";
import type { GeminiGenerateRequest } from "@/lib/protocol/gemini";
import type { ApiKey } from "@/lib/db/types";

const MODEL = "gemini-2.5-flash";
const UPSTREAM_MODEL = "gemini-2.5-flash-2024-07-18";

async function setup(): Promise<{ key: ApiKey; userId: string }> {
  const u = await createUser({
    username: "gdx-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  return { key: created.key, userId: u.id };
}

/**
 * A vendor that speaks Gemini, with the route table saying so.
 *
 * Only the Gemini surface is served: the point of this row is that one
 * surface is answered directly, and the others are not answered at all.
 */
async function setupGeminiProvider(): Promise<void> {
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

/** A row written before the table existed: the older columns decide. */
async function setupLegacyProvider(): Promise<void> {
  await createProvider({
    name: "Test Chat",
    kind: "openai",
    apiKey: "sk-upstream-chat",
    priority: 1,
    upstreamFormat: "chat",
    baseUrl: "https://api.openai.com/v1",
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

/** A Gemini answer, with the fields the pivot would have dropped. */
const answer = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "hello there" }] },
      finishReason: "STOP",
      index: 0,
      safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" }],
    },
  ],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 30,
    totalTokenCount: 42,
    cachedContentTokenCount: 8,
  },
  modelVersion: UPSTREAM_MODEL,
  responseId: "resp-gemini-1",
};

describe("the Gemini surface, answered directly", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("sends the client's body out exactly as it arrived", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    // A body with the two things the pivot cannot carry: a thinking budget and
    // a safety setting. On the translated path both are dropped.
    const body: GeminiGenerateRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        temperature: 0.4,
        topK: 40,
        thinkingConfig: { thinkingBudget: 8000, includeThoughts: true },
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      ],
    };

    const result = await proxyGeminiGenerate({
      body,
      model: MODEL,
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(sent).toEqual(body);
  });

  it("goes to Google's own endpoint, with the key in Google's carrier", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(answer), {
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

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${UPSTREAM_MODEL}:generateContent`,
    );
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("sk-upstream-gemini");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("hands the answer back exactly as it arrived", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await proxyGeminiGenerate({
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      model: MODEL,
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    // The safety ratings and the response id are still on it: nothing was
    // taken off on the way through.
    expect(result.data).toEqual(answer);
  });

  it("bills the turn by Gemini's own count", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(answer), {
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
    expect(rows[0].promptTokens).toBe(12);
    expect(rows[0].completionTokens).toBe(30);
    // The cached slice of the prompt is reported, not rounded to zero.
    expect(rows[0].cachedPromptTokens).toBe(8);
  });

  it("hands a stream over as the upstream wrote it", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    // Google's own frames: the text arrives in pieces, the usage on the last
    // chunk, and nothing says "Responses" or "Chat" anywhere in them.
    const sse = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"he"}]},"index":0}],"modelVersion":"' +
        UPSTREAM_MODEL +
        '"}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"llo"}]},"index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2,"totalTokenCount":7}}',
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
      model: MODEL,
      stream: true,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    expect(result.body).toBeTruthy();
    // The bytes are the upstream's own, in the upstream's own framing.
    expect(await new Response(result.body!).text()).toBe(sse);

    // And the streaming endpoint was the one that was asked for.
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${UPSTREAM_MODEL}:streamGenerateContent?alt=sse`,
    );

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(5);
    expect(rows[0].completionTokens).toBe(2);
  });

  it("frames a whole answer when the upstream ignores the streaming endpoint", async () => {
    const { key, userId } = await setup();
    await setupGeminiProvider();

    // Google answers the streaming endpoint with a JSON **array** of chunks
    // when `alt=sse` does not arrive. The client asked for a stream, so it
    // gets one — the chunks, framed.
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify([
            { candidates: [{ content: { role: "model", parts: [{ text: "he" }] } }] },
            {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "llo" }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
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
    expect(result.body).toBeTruthy();
    const frames = (await new Response(result.body!).text())
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    expect(frames).toHaveLength(2);
    expect(frames[1].candidates[0].finishReason).toBe("STOP");

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(5);
  });
});

describe("a row that predates the route table", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("is still answered through the hub", async () => {
    // The derivation reproduces what the proxy used to do, so a row written
    // before the table existed keeps its traffic — the Gemini body is still
    // rewritten into the pivot's shape on the way out.
    const { key, userId } = await setup();
    await setupLegacyProvider();

    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: UPSTREAM_MODEL,
            choices: [
              { index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await proxyGeminiGenerate({
      body: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }],
      },
      model: MODEL,
      stream: false,
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(result.ok).toBe(true);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    // A Chat body, not a Gemini one: the body was rewritten twice on the way
    // out — Gemini to the pivot, the pivot to Chat.
    expect(sent.contents).toBeUndefined();
    expect(sent.input).toBeUndefined();
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    // And the safety setting is gone — which is the whole difference between
    // the two paths, and the reason the direct one exists.
    expect(sent.safetySettings).toBeUndefined();
  });
});
