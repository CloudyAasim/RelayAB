/**
 * tests/integration/cross-protocol.test.ts
 *
 * A vendor that only publishes an Anthropic Messages endpoint, called by
 * clients that speak something else.
 *
 * This used to be impossible, and not because the conversion was missing: the
 * code for it was written and never called. An Anthropic-format row was
 * excluded from the OpenAI surfaces, so a Claude model was invisible to an
 * OpenAI SDK, a Responses client and a Gemini client — and the checkbox that
 * said otherwise could not be moved, because the editor forced it off.
 *
 * What is pinned here:
 *  - the OpenAI, Responses and Gemini surfaces all reach such a vendor, and
 *    the upstream sees an Anthropic-shaped request;
 *  - the Anthropic surface of the same row still goes out natively;
 *  - a call is billed once, on the row that served it;
 *  - the surfaces with no Anthropic equivalent (embeddings, rerank) still
 *    refuse such a row instead of inventing a translation for them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as chatPOST } from "@/app/api/v1/chat/completions/route";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";
import { POST as messagesPOST } from "@/app/api/v1/messages/route";
import { POST as embeddingsPOST } from "@/app/api/v1/embeddings/route";
import { POST as rerankPOST } from "@/app/api/v1/rerank/route";
import { POST as geminiPOST } from "@/app/api/v1beta/models/[...path]/route";

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-up",
  content: [{ type: "text", text: "via messages" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 6 },
});

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: UpstreamCall[] = [];

function stubUpstream(body = ANTHROPIC_JSON, status = 200): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: { headers?: Record<string, string>; body?: unknown } = {}) => {
      calls.push({
        url: String(url),
        headers: init.headers ?? {},
        body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

/**
 * One row: an Anthropic vendor, with the OpenAI side switched on.
 *
 * The OpenAI side being on is the whole point — it is what says "the OpenAI
 * surfaces are served for this row, by translating".
 */
async function seed(): Promise<{ plain: string; keyId: string }> {
  const user = await createUser({
    username: "x-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Claude Only",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-upstream",
    enabled: true,
    upstreamFormat: "anthropic",
    openaiEnabled: true,
    anthropicEnabled: true,
    modelMapping: { "client-m": "claude-up" },
  });
  return { plain: created.plainKey, keyId: created.key.id };
}

function bearer(plain: string): Record<string, string> {
  return { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" };
}

describe("an Anthropic-only vendor, called from the OpenAI side", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a Chat Completions client", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({
          model: "client-m",
          messages: [
            { role: "system", content: "be brief" },
            { role: "user", content: "hi" },
          ],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("via messages");
    expect(body.usage.prompt_tokens).toBe(4);
    expect(body.usage.completion_tokens).toBe(6);

    // One call, to the Anthropic endpoint, with Anthropic's credentials and
    // Anthropic's request shape — the Chat body was converted, not forwarded.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-upstream");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
    // The system prompt moved to the field Anthropic calls `system`.
    expect(calls[0].body.system).toBe("be brief");
    expect(calls[0].body.model).toBe("claude-up");
  });

  it("answers a Responses client", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { output_text: string; usage: { input_tokens: number } };
    expect(body.output_text).toBe("via messages");
    expect(body.usage.input_tokens).toBe(4);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("answers a Gemini client", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await geminiPOST(
      new Request("http://localhost:3000/v1beta/models/client-m:generateContent", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      { params: Promise.resolve({ path: ["models", "client-m:generateContent"] }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    };
    expect(body.candidates[0].content.parts).toEqual([{ text: "via messages" }]);
    expect(body.usageMetadata.promptTokenCount).toBe(4);
    expect(body.usageMetadata.candidatesTokenCount).toBe(6);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("still serves the Anthropic surface of the same row natively", async () => {
    // Translation is an addition, not a replacement: the row was already
    // reachable from an Anthropic client, and it stays reachable.
    const { plain } = await seed();
    stubUpstream();

    const res = await messagesPOST(
      new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: { "x-api-key": plain, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "client-m",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe("via messages");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("bills the call once, on the row that served it", async () => {
    // The request changed shape twice on the way out and twice on the way
    // back. That must not turn into two usage rows.
    const { plain, keyId } = await seed();
    stubUpstream();

    await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({
          model: "client-m",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(4);
    expect(rows[0].completionTokens).toBe(6);
    expect(rows[0].status).toBe("success");
  });

  it("reports an upstream failure as a failure, without retrying elsewhere", async () => {
    // One protocol per request: a failing Anthropic vendor must not make the
    // gateway look for another vendor to try.
    const { plain } = await seed();
    stubUpstream(JSON.stringify({ error: { message: "upstream exploded" } }), 500);

    const res = await chatPOST(
      new Request("http://localhost:3000/v1/chat/completions", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({
          model: "client-m",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_error");
    expect(calls).toHaveLength(1);
  });
});

describe("the surfaces Anthropic has no equivalent for", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses an embeddings request rather than inventing a translation", async () => {
    // The Anthropic Messages protocol has no embeddings endpoint, and there is
    // nothing to translate a vector into. Serving it anyway would mean posting
    // a body the vendor will reject — and charging for the attempt.
    const { plain } = await seed();
    stubUpstream();

    const res = await embeddingsPOST(
      new Request("http://localhost:3000/v1/embeddings", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_mapped");
    expect(calls).toHaveLength(0);
  });

  it("refuses a rerank request for the same reason", async () => {
    const { plain } = await seed();
    stubUpstream();

    const res = await rerankPOST(
      new Request("http://localhost:3000/v1/rerank", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", query: "hi", documents: ["a", "b"] }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_mapped");
    expect(calls).toHaveLength(0);
  });
});
