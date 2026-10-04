/**
 * tests/unit/proxy-cache-billing.test.ts
 *
 * The cache buckets, from an upstream's own wire format to the usage row.
 *
 * `quota-cache.test.ts` proves the arithmetic on numbers typed by hand. This
 * proves the numbers survive the trip: a fake upstream answers with the exact
 * JSON shape OpenAI and Anthropic use, and the test checks what the gateway
 * records and charges.
 *
 * That gap is the whole reason the feature did not exist. Both parsers
 * *received* the cache fields — they are on the same parsed object as the token
 * counts — and read only the counts, so nothing about the wire format was ever
 * in question. What was missing was somebody checking the end of the line.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider, updateProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyChatCompletion } from "@/lib/proxy/openai";
import { proxyAnthropicMessage } from "@/lib/proxy/anthropic";

async function setup(opts: { cachedInputCost?: number; cacheWriteCost?: number } = {}) {
  const u = await createUser({
    username: "cache-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1_000_000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: u.id, label: "l" });

  const p = await createProvider({
    name: "Cache Vendor",
    kind: "openai",
    apiKey: "sk-upstream-test",
    modelConfigs: {
      chat: {
        clientId: "chat",
        upstreamId: "chat-upstream",
        inputCost: 1000,
        outputCost: 1000,
        ...(opts.cachedInputCost !== undefined
          ? { cachedInputCost: opts.cachedInputCost }
          : {}),
        ...(opts.cacheWriteCost !== undefined ? { cacheWriteCost: opts.cacheWriteCost } : {}),
      },
    },
    modelMapping: { chat: "chat-upstream" },
  });
  // Both faces on, so the Anthropic path can be exercised on the same row.
  const withAnthropic = await updateProvider(p.id, {
    openaiEnabled: true,
    anthropicEnabled: true,
    anthropicBaseUrl: null,
  });
  return {
    key: created.key,
    user: (await getUserById(u.id))!,
    providerId: withAnthropic!.id,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** One OpenAI chat completion whose usage reports a cache hit. */
const chatWithCache = (over: Record<string, unknown> = {}) =>
  json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1695273600,
    model: "chat-upstream",
    choices: [
      { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      total_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 800_000 },
      ...over,
    },
  });

describe("a cached request is recorded and priced as one", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("OpenAI shape: the subset is read, recorded, and discounted", async () => {
    const { key, user } = await setup({ cachedInputCost: 100 });
    const fetchMock = vi.fn(async () => chatWithCache());

    await proxyChatCompletion({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    // The bucket is on the row, and it is the *read* not the write: the wire
    // format carries no write count here, and recording 0 for it would claim
    // the request wrote nothing when in fact nothing was said either way.
    expect(row.cachedPromptTokens).toBe(800_000);
    expect(row.cacheWriteTokens).toBe(0);
    // The token total stays the prompt, because a subset is not extra work.
    expect(row.totalTokens).toBe(1_000_000);
    // 200k uncached × 1000 + 800k cached × 100 = 280M → 280_000
    expect(row.creditsUsed).toBe(280_000);
  });

  it("a vendor with no cache leaves the columns absent, not zero", async () => {
    // "This vendor does not cache" and "0% hit rate" are different facts, and
    // only the first is a claim about the provider — the second would need
    // revisiting when they add it.
    const { key, user } = await setup({ cachedInputCost: 100 });
    const fetchMock = vi.fn(async () =>
      chatWithCache({ prompt_tokens_details: undefined }),
    );

    await proxyChatCompletion({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    expect(row.cachedPromptTokens).toBeUndefined();
    expect(row.cacheWriteTokens).toBeUndefined();
    expect(row.creditsUsed).toBe(1_000_000);
  });

  it("costs exactly what it did before when the rate is unconfigured", async () => {
    // A model row written before caching existed must not silently reprice.
    const { key, user } = await setup();
    const fetchMock = vi.fn(async () => chatWithCache());

    await proxyChatCompletion({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    expect(row.creditsUsed).toBe(1_000_000);
  });

  it("Anthropic shape: both disjoint buckets are read and priced apart", async () => {
    const { key, user } = await setup({ cachedInputCost: 100, cacheWriteCost: 1250 });
    const fetchMock = vi.fn(async () =>
      json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "chat-upstream",
        content: [{ type: "text", text: "Hi!" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        // `input_tokens` counts only what missed: 200k. The other 1.3M came
        // from the cache. buckets (1.3M) > prompt (200k), so this is provably
        // the disjoint convention.
        usage: {
          input_tokens: 200_000,
          output_tokens: 0,
          cache_creation_input_tokens: 500_000,
          cache_read_input_tokens: 800_000,
        },
      }),
    );

    await proxyAnthropicMessage({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }], max_tokens: 16 },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    expect(row.cachedPromptTokens).toBe(800_000);
    expect(row.cacheWriteTokens).toBe(500_000);
    // 200k × 1000 + 800k × 100 + 500k × 1250 = 200M + 80M + 625M = 905M → 905_000
    expect(row.creditsUsed).toBe(905_000);
  });

  it("DeepSeek's hit counter is read like any other spelling", async () => {
    const { key, user } = await setup({ cachedInputCost: 100 });
    // Its own shape, not the OpenAI one with a field added: a vendor that
    // reports a hit counter does not also report `prompt_tokens_details`, and
    // leaving both in would be answered by the "largest plausible hit" rule
    // rather than by the spelling under test.
    const fetchMock = vi.fn(async () =>
      json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1695273600,
        model: "chat-upstream",
        choices: [
          { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_cache_hit_tokens: 600_000,
          prompt_cache_miss_tokens: 400_000,
        },
      }),
    );

    await proxyChatCompletion({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    expect(row.cachedPromptTokens).toBe(600_000);
    // 400k × 1000 + 600k × 100 = 460M → 460_000
    expect(row.creditsUsed).toBe(460_000);
  });

  it("takes the larger hit when a vendor reports two spellings at once", async () => {
    // The wrong-but-smaller number is the one that quietly under-discounts, so
    // ambiguity resolves upward. Not reachable from a real vendor; pinned so the
    // rule is a decision rather than an accident.
    const { key, user } = await setup({ cachedInputCost: 100 });
    const fetchMock = vi.fn(async () =>
      chatWithCache({ prompt_cache_hit_tokens: 600_000 }),
    );

    await proxyChatCompletion({
      req: { model: "chat", messages: [{ role: "user", content: "Hi" }] },
      apiKey: key,
      user,
      deps: { fetchImpl: fetchMock as unknown as typeof fetch },
    });

    const [row] = await listUsageByKey(key.id);
    expect(row.cachedPromptTokens).toBe(800_000);
  });
});
