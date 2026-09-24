/**
 * One provider, two protocol faces.
 *
 * A vendor that speaks both OpenAI and Anthropic protocols used to need two
 * provider rows, duplicating the API key, the model mapping and the model
 * configs. Both faces now live on one row:
 *
 *   { upstreamFormat: "chat", anthropicEnabled: true, anthropicBaseUrl: … }
 *
 * These tests pin two things:
 *   1. resolution — which faces a row exposes, including the legacy shapes;
 *   2. routing — each surface picks the face it asked for, and a failure is
 *      reported as a failure. There is deliberately NO automatic fallback to
 *      another protocol: one protocol per request, chosen by configuration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider, getProviderById } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { providerFaces, type Provider } from "@/lib/db/types";
import { intersectClientModels } from "@/lib/proxy/model-catalog";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";
import { POST as messagesPOST } from "@/app/api/v1/messages/route";

const CHAT_JSON = JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "up-model",
  choices: [{ index: 0, message: { role: "assistant", content: "via chat" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "up-model",
  content: [{ type: "text", text: "via messages" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 6 },
});

let apiKeyPlain = "";
let apiKeyId = "";
let calls: Array<{ url: string; headers: Record<string, string> }> = [];

function stubUpstream(status = 200, body = CHAT_JSON): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {} });
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function seedUserAndKey(): Promise<void> {
  const user = await createUser({
    username: "faces-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  apiKeyPlain = created.plainKey;
  apiKeyId = created.key.id;
}

function row(over: Partial<Provider>): Provider {
  return {
    id: "p1",
    name: "p",
    kind: "openai",
    baseUrl: null,
    encryptedApiKey: "x",
    modelMapping: {},
    modelConfigs: {},
    enabled: true,
    priority: 0,
    headers: {},
    upstreamFormat: "responses",
    openaiEnabled: true,
    anthropicEnabled: false,
    anthropicBaseUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function responsesRequest(): Request {
  return new Request("http://localhost:3000/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyPlain}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "client-m", input: "hi" }),
  });
}

function messagesRequest(): Request {
  return new Request("http://localhost:3000/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKeyPlain, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "client-m",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

describe("providerFaces", () => {
  it("hides the models of a provider whose faces are all off", () => {
    const key = { allowedModels: [] } as never;
    const live = row({
      modelMapping: { "live-model": "up" },
      upstreamFormat: "chat",
      anthropicEnabled: true,
    });
    const dead = row({
      id: "p2",
      modelMapping: { "dead-model": "up" },
      openaiEnabled: false,
      anthropicEnabled: false,
    });
    expect(intersectClientModels([live, dead], key)).toEqual(["live-model"]);
  });

  it("gives a plain row the OpenAI face only", () => {
    expect(providerFaces(row({ upstreamFormat: "chat" }))).toEqual({
      openai: { format: "chat" },
      anthropic: null,
    });
  });

  it("treats a legacy upstreamFormat=anthropic row as Anthropic-only", () => {
    expect(
      providerFaces(row({ upstreamFormat: "anthropic", baseUrl: "https://api.agnes-ai.cn" })),
    ).toEqual({
      openai: null,
      anthropic: { baseUrl: "https://api.agnes-ai.cn" },
    });
  });

  it("treats a legacy kind=anthropic row as Anthropic-only", () => {
    const faces = providerFaces(
      row({ kind: "anthropic", anthropicEnabled: true, openaiEnabled: false }),
    );
    expect(faces.openai).toBeNull();
    expect(faces.anthropic).not.toBeNull();
  });

  it("exposes both faces on one row", () => {
    expect(
      providerFaces(
        row({ upstreamFormat: "chat", anthropicEnabled: true, baseUrl: "https://v.test/v1" }),
      ),
    ).toEqual({
      openai: { format: "chat" },
      anthropic: { baseUrl: "https://v.test" }, // one trailing /v1 is stripped
    });
  });

  it("prefers an explicit Anthropic base URL over the derived one", () => {
    expect(
      providerFaces(
        row({
          baseUrl: "https://api.deepseek.com",
          anthropicEnabled: true,
          anthropicBaseUrl: "https://api.deepseek.com/anthropic",
        }),
      ).anthropic,
    ).toEqual({ baseUrl: "https://api.deepseek.com/anthropic" });
  });

  it("can disable the OpenAI face and keep only Anthropic", () => {
    const faces = providerFaces(row({ openaiEnabled: false, anthropicEnabled: true }));
    expect(faces.openai).toBeNull();
    expect(faces.anthropic).not.toBeNull();
  });
});

describe("one provider serving both surfaces", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedBothFaces(): Promise<void> {
    await seedUserAndKey();
    await createProvider({
      name: "Agnes CN",
      kind: "openai",
      baseUrl: "https://api.agnes-ai.cn/v1",
      apiKey: "sk-upstream-secret",
      enabled: true,
      upstreamFormat: "chat",
      anthropicEnabled: true,
      modelMapping: { "client-m": "up-model" },
    });
  }

  it("serves /v1/responses over Chat Completions", async () => {
    await seedBothFaces();
    stubUpstream();

    const res = await responsesPOST(responsesRequest());

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).output_text).toBe("via chat");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.agnes-ai.cn/v1/chat/completions");
  });

  it("serves /v1/messages from the same row, same key, same model mapping", async () => {
    await seedBothFaces();
    stubUpstream(200, ANTHROPIC_JSON);

    const res = await messagesPOST(messagesRequest());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe("via messages");
    // Only the Anthropic face's URL differs; the credentials come from the same row.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.agnes-ai.cn/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-upstream-secret");

    const stored = await getProviderById((await getFirstProviderId()));
    expect(stored?.modelMapping).toEqual({ "client-m": "up-model" });
  });

  it("does NOT switch protocol when the configured one fails", async () => {
    // A chat-format provider whose upstream is down must surface the failure,
    // not silently retry over another protocol.
    await seedBothFaces();
    stubUpstream(500, JSON.stringify({ error: { message: "upstream exploded" } }));

    const res = await responsesPOST(responsesRequest());

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_error");
    // Exactly one attempt, against the configured protocol.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.agnes-ai.cn/v1/chat/completions");

    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].errorMessage).toContain("HTTP 500");
  });

  it("does NOT convert a responses-format provider to Chat Completions", async () => {
    await seedUserAndKey();
    await createProvider({
      name: "Native Responses",
      kind: "openai",
      baseUrl: "https://native.test/v1",
      apiKey: "sk-upstream",
      enabled: true,
      upstreamFormat: "responses",
      modelMapping: { "client-m": "up-model" },
    });
    stubUpstream(500);

    const res = await responsesPOST(responsesRequest());

    expect(res.status).toBe(502);
    expect(calls.map((c) => c.url)).toEqual(["https://native.test/v1/responses"]);
  });
});

async function getFirstProviderId(): Promise<string> {
  const { listProviders } = await import("@/lib/db/providers");
  const [first] = await listProviders();
  return first.id;
}
