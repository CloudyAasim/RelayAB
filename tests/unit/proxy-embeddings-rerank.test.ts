/**
 * tests/unit/proxy-embeddings-rerank.test.ts
 *
 * The two model classes that are not chat: an embedding call and a rerank.
 *
 * What is pinned here is mostly about *not* being a chat call in disguise —
 * no output tokens, no invented message, and the vendor's own token counts
 * read from wherever that vendor puts them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { proxyEmbeddings, validateEmbeddingsBody, embeddingsUsage } from "@/lib/proxy/embeddings";
import { proxyRerank, validateRerankBody, rerankUsage } from "@/lib/proxy/rerank";
import type { ApiKey } from "@/lib/db/types";

async function setup(): Promise<{ key: ApiKey; userId: string }> {
  const u = await createUser({
    username: "emb-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  return { key: created.key, userId: u.id };
}

async function setupProvider(model: string, cost: number): Promise<void> {
  await createProvider({
    name: "Test OpenAI",
    kind: "openai",
    apiKey: "sk-upstream-test",
    priority: 1,
    modelConfigs: {
      [model]: {
        clientId: model,
        upstreamId: `${model}-2024-07-18`,
        inputCost: cost,
        outputCost: cost,
      },
    },
    modelMapping: { [model]: `${model}-2024-07-18` },
  });
}

describe("the embeddings endpoint", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("forwards the request and returns the upstream's own body", async () => {
    const { key, userId } = await setup();
    await setupProvider("text-embedding-3-small", 20);

    const upstream = {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "text-embedding-3-small-2024-07-18",
      usage: { prompt_tokens: 8, total_tokens: 8 },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await proxyEmbeddings({
      req: { model: "text-embedding-3-small", input: "hello" },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/embeddings",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(upstream);
    // The upstream's model name went out, not the client's.
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(sent.model).toBe("text-embedding-3-small-2024-07-18");
    expect(sent.input).toBe("hello");
  });

  it("bills the prompt tokens and nothing else", async () => {
    const { key, userId } = await setup();
    await setupProvider("text-embedding-3-small", 20);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1] }],
          usage: { prompt_tokens: 1000, total_tokens: 1000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await proxyEmbeddings({
      req: { model: "text-embedding-3-small", input: "hello" },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/embeddings",
      },
    });

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(1000);
    // An embedding call produces no output tokens.
    expect(rows[0].completionTokens).toBe(0);
    expect(rows[0].status).toBe("success");
  });

  it("records the failure and charges nothing when the upstream is down", async () => {
    const { key, userId } = await setup();
    await setupProvider("text-embedding-3-small", 20);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("boom", { status: 500 }));

    const result = await proxyEmbeddings({
      req: { model: "text-embedding-3-small", input: "hello" },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.openai.com/v1/embeddings",
      },
    });

    expect(result.ok).toBe(false);
    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].creditsUsed).toBe(0);
    expect((await getUserById(userId))!.quotaUsed).toBe(0);
  });

  it("says so when no provider serves the model", async () => {
    const { key, userId } = await setup();
    const result = await proxyEmbeddings({
      req: { model: "nope", input: "hello" },
      apiKey: key,
      user: (await getUserById(userId))!,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("model_not_mapped");
  });
});

describe("the embeddings request shape", () => {
  it("accepts the four input shapes OpenAI accepts", () => {
    expect(validateEmbeddingsBody({ model: "m", input: "a" }).ok).toBe(true);
    expect(validateEmbeddingsBody({ model: "m", input: ["a", "b"] }).ok).toBe(true);
    expect(validateEmbeddingsBody({ model: "m", input: [1, 2] }).ok).toBe(true);
    expect(validateEmbeddingsBody({ model: "m", input: [[1, 2]] }).ok).toBe(true);
  });

  it("refuses a body it cannot forward", () => {
    expect(validateEmbeddingsBody({ input: "a" }).ok).toBe(false);
    expect(validateEmbeddingsBody({ model: "m" }).ok).toBe(false);
    expect(validateEmbeddingsBody({ model: "m", input: 42 }).ok).toBe(false);
    expect(validateEmbeddingsBody({ model: "m", input: [{}] }).ok).toBe(false);
  });
});

describe("the embeddings usage", () => {
  it("reads both spellings and nothing else", () => {
    expect(embeddingsUsage({ prompt_tokens: 10 })).toEqual({
      promptTokens: 10,
      completionTokens: 0,
    });
    expect(embeddingsUsage({ input_tokens: 7 })).toEqual({
      promptTokens: 7,
      completionTokens: 0,
    });
    expect(embeddingsUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("the rerank endpoint", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("forwards the request and returns the upstream's own body", async () => {
    const { key, userId } = await setup();
    await setupProvider("rerank-v3", 10);

    const upstream = {
      id: "r-1",
      results: [{ index: 2, relevance_score: 0.91, document: { text: "b" } }],
      meta: { tokens: { input_tokens: 120, output_tokens: 1 } },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await proxyRerank({
      req: { model: "rerank-v3", query: "q", documents: ["a", "b"] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.cohere.com/v1/rerank",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual(upstream);
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(sent.model).toBe("rerank-v3-2024-07-18");
    expect(sent.query).toBe("q");
    expect(sent.documents).toEqual(["a", "b"]);
  });

  it("bills the tokens Cohere reports", async () => {
    const { key, userId } = await setup();
    await setupProvider("rerank-v3", 10);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: "r-1",
          results: [],
          meta: { tokens: { input_tokens: 300, output_tokens: 1 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await proxyRerank({
      req: { model: "rerank-v3", query: "q", documents: ["a"] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.cohere.com/v1/rerank",
      },
    });

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(300);
    expect((await getUserById(userId))!.quotaUsed).toBeGreaterThan(0);
  });

  it("bills the tokens Jina reports", async () => {
    const { key, userId } = await setup();
    await setupProvider("rerank-v3", 10);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          model: "rerank-v3",
          results: [{ index: 0, document: { text: "a" }, relevance_score: 0.5 }],
          usage: { prompt_tokens: 250, total_tokens: 250 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await proxyRerank({
      req: { model: "rerank-v3", query: "q", documents: ["a"] },
      apiKey: key,
      user: (await getUserById(userId))!,
      deps: {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        upstreamUrlFor: () => "https://api.jina.ai/v1/rerank",
      },
    });

    const rows = await listUsageByKey(key.id);
    expect(rows[0].promptTokens).toBe(250);
  });
});

describe("the rerank usage", () => {
  it("reads the Cohere shape and the Jina shape", () => {
    expect(rerankUsage({ meta: { tokens: { input_tokens: 5, output_tokens: 1 } } })).toEqual({
      promptTokens: 5,
      completionTokens: 1,
    });
    expect(rerankUsage({ usage: { prompt_tokens: 9, total_tokens: 9 } })).toEqual({
      promptTokens: 9,
      completionTokens: 0,
    });
  });

  it("reports nothing when the vendor reports nothing", () => {
    expect(rerankUsage({ results: [] })).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});

describe("the rerank request shape", () => {
  it("accepts what both dialects accept", () => {
    expect(validateRerankBody({ model: "m", query: "q", documents: ["a"] }).ok).toBe(true);
    expect(validateRerankBody({ model: "m", query: "q", documents: ["a"], top_n: 2 }).ok).toBe(true);
  });

  it("refuses a body it cannot forward", () => {
    expect(validateRerankBody({ query: "q", documents: ["a"] }).ok).toBe(false);
    expect(validateRerankBody({ model: "m", documents: ["a"] }).ok).toBe(false);
    expect(validateRerankBody({ model: "m", query: "q" }).ok).toBe(false);
    expect(validateRerankBody({ model: "m", query: "q", documents: [] }).ok).toBe(false);
    expect(validateRerankBody({ model: "m", query: "q", documents: [1] }).ok).toBe(false);
  });
});
