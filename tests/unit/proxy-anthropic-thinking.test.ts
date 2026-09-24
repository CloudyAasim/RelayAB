/**
 *
 * Reasoning blocks on the Anthropic surface.
 *
 * Reasoning models served through an Anthropic-compatible upstream often send
 * `content: [{type:"thinking"}, {type:"text"}]` even though the caller never
 * enabled extended thinking. ONLYOFFICE's AI plugin reads the answer from
 * `content[0]`, so a leading thinking block makes the editor render an empty
 * reply although the request returned HTTP 200.
 *
 * Contract pinned here:
 *   - `thinking` was NOT requested  → reasoning blocks are dropped
 *   - `thinking: {type:"enabled"}`  → payload is passed through untouched
 *   - billing still uses the upstream usage numbers
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import {
  isThinkingRequested,
  proxyAnthropicMessage,
  stripUnrequestedThinking,
} from "@/lib/proxy/anthropic";
import type { ApiKey } from "@/lib/db/types";

const THINKING_BLOCK = {
  type: "thinking",
  thinking: "让我想想……",
  signature: "sig",
};
const TEXT_BLOCK = { type: "text", text: "在线" };

async function setupUserAndKey(): Promise<{
  key: ApiKey;
  user: NonNullable<Awaited<ReturnType<typeof getUserById>>>;
}> {
  const u = await createUser({
    username: "anth-think-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const result = await createApiKey({ userId: u.id, label: "l" });
  return { key: result.key, user: (await getUserById(u.id))! };
}

async function setupProvider(): Promise<void> {
  await createProvider({
    name: "Test Anthropic",
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelMapping: { "client-m": "up-model" },
  });
}

function upstreamResponse(content: unknown[]): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "up-model",
          content,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 11 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

async function call(
  content: unknown[],
  extra: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text?: string }> }> {
  await setupProvider();
  const { key, user } = await setupUserAndKey();

  const r = await proxyAnthropicMessage({
    req: {
      model: "client-m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 128,
      ...extra,
    },
    apiKey: key,
    user,
    deps: { fetchImpl: upstreamResponse(content) },
  });

  expect(r.ok).toBe(true);
  return r.data as { content: Array<{ type: string; text?: string }> };
}

describe("isThinkingRequested", () => {
  it("is false when the field is absent", () => {
    expect(isThinkingRequested({})).toBe(false);
  });

  it("is false when thinking is explicitly disabled", () => {
    expect(isThinkingRequested({ thinking: { type: "disabled" } })).toBe(false);
  });

  it("is true only for { type: 'enabled' }", () => {
    expect(isThinkingRequested({ thinking: { type: "enabled", budget_tokens: 1024 } })).toBe(true);
    expect(isThinkingRequested({ thinking: true })).toBe(false);
    expect(isThinkingRequested({ thinking: "enabled" })).toBe(false);
  });
});

describe("stripUnrequestedThinking", () => {
  it("drops thinking and redacted_thinking blocks", () => {
    const body = {
      content: [THINKING_BLOCK, { type: "redacted_thinking", data: "x" }, TEXT_BLOCK],
    };
    expect(stripUnrequestedThinking(body).content).toEqual([TEXT_BLOCK]);
  });

  it("returns the same object when there is nothing to drop", () => {
    const body = { content: [TEXT_BLOCK] };
    expect(stripUnrequestedThinking(body)).toBe(body);
  });

  it("ignores bodies without a content array", () => {
    const body = { content: "text" };
    expect(stripUnrequestedThinking(body)).toBe(body);
  });
});

describe("proxyAnthropicMessage reasoning blocks", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("drops a leading thinking block when the client did not ask for it", async () => {
    const data = await call([THINKING_BLOCK, TEXT_BLOCK]);
    expect(data.content).toEqual([TEXT_BLOCK]);
  });

  it("drops thinking when the client disabled it explicitly", async () => {
    const data = await call([THINKING_BLOCK, TEXT_BLOCK], { thinking: { type: "disabled" } });
    expect(data.content).toEqual([TEXT_BLOCK]);
  });

  it("keeps thinking blocks when the client enabled them", async () => {
    const data = await call([THINKING_BLOCK, TEXT_BLOCK], {
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    expect(data.content).toEqual([THINKING_BLOCK, TEXT_BLOCK]);
  });

  it("leaves a text-only response untouched", async () => {
    const data = await call([TEXT_BLOCK]);
    expect(data.content).toEqual([TEXT_BLOCK]);
  });

  it("empties content when the upstream only produced reasoning", async () => {
    const data = await call([THINKING_BLOCK]);
    expect(data.content).toEqual([]);
  });

  it("still bills the upstream usage numbers", async () => {
    await setupProvider();
    const { key, user } = await setupUserAndKey();

    const r = await proxyAnthropicMessage({
      req: {
        model: "client-m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 128,
      },
      apiKey: key,
      user,
      deps: { fetchImpl: upstreamResponse([THINKING_BLOCK, TEXT_BLOCK]) },
    });

    expect(r.ok).toBe(true);
    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(7);
    expect(logs[0].completionTokens).toBe(11);
  });
});
