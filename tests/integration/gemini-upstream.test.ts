/**
 * tests/integration/gemini-upstream.test.ts
 *
 * A vendor that publishes Google's own API, called by clients that speak
 * something else.
 *
 * Until now the gateway could only *be* Google — it answered the Gemini
 * client surface — and never *talk to* Google: `upstreamFormat` had no
 * "gemini", so a Gemini model had to be reached through some other vendor's
 * OpenAI-compatible relay.
 *
 * What is pinned here:
 *  - the upstream sees Gemini's shape: `contents` in, `candidates` out, at
 *    `POST {base}/models/{model}:generateContent`, with the key in
 *    `x-goog-api-key`;
 *  - the OpenAI, Responses and Gemini client surfaces all reach it;
 *  - the Anthropic surface does **not**: Google's base has no Anthropic
 *    endpoint under it, and a row that pretended otherwise would 404;
 *  - a call is billed once, on the tokens the vendor reported.
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
import { POST as geminiPOST } from "@/app/api/v1beta/models/[...path]/route";

const GEMINI_JSON = JSON.stringify({
  candidates: [
    {
      content: { role: "model", parts: [{ text: "via gemini" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
  modelVersion: "gemini-2.5-flash",
  responseId: "resp_gemini_1",
});

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: UpstreamCall[] = [];

function stubUpstream(body = GEMINI_JSON, status = 200): void {
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

/** One row: a Google vendor, reachable through the OpenAI side. */
async function seed(): Promise<{ plain: string; keyId: string }> {
  const user = await createUser({
    username: "g-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Google",
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "AIza-upstream",
    enabled: true,
    upstreamFormat: "gemini",
    openaiEnabled: true,
    anthropicEnabled: false,
    modelMapping: { "client-m": "gemini-2.5-flash" },
  });
  return { plain: created.plainKey, keyId: created.key.id };
}

function bearer(plain: string): Record<string, string> {
  return { Authorization: `Bearer ${plain}`, "Content-Type": "application/json" };
}

describe("a Gemini upstream", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a Responses client, and the upstream sees Gemini's shape", async () => {
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
    const body = (await res.json()) as {
      output_text: string;
      status: string;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };
    expect(body.output_text).toBe("via gemini");
    expect(body.status).toBe("completed");
    // Gemini counts in `usageMetadata`; the pivot's shape is what the client
    // and the billing code read.
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 6, total_tokens: 10 });

    // The endpoint is Google's, the key travels in Google's carrier, and the
    // body is `contents` — not a Responses body posted at a Gemini URL.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(calls[0].headers["x-goog-api-key"]).toBe("AIza-upstream");
    expect(calls[0].body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(calls[0].body.model).toBeUndefined();
  });

  it("answers a Chat client", async () => {
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
    expect(body.choices[0].message.content).toBe("via gemini");
    expect(body.usage.prompt_tokens).toBe(4);

    // The Chat body was converted: Gemini never sees `messages`.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages).toBeUndefined();
    expect(calls[0].body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(calls[0].body.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
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
      candidates: Array<{ content: { parts: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
    };
    expect(body.candidates[0].content.parts).toEqual([{ text: "via gemini" }]);
    expect(body.candidates[0].finishReason).toBe("STOP");
    expect(body.usageMetadata.promptTokenCount).toBe(4);
    expect(body.usageMetadata.candidatesTokenCount).toBe(6);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });

  it("does not pretend it speaks Anthropic", async () => {
    // Google's base has no Anthropic endpoint under it. A row that claimed
    // otherwise would answer every /v1/messages with a 404 from the vendor,
    // and the caller would have no way to tell that from a bad request.
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

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_mapped");
    expect(calls).toHaveLength(0);
  });

  it("bills the call once, on the tokens the vendor reported", async () => {
    const { plain, keyId } = await seed();
    stubUpstream();

    await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi" }),
      }),
    );

    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(4);
    expect(rows[0].completionTokens).toBe(6);
    expect(rows[0].status).toBe("success");
  });

  it("reports an upstream failure as a failure, without retrying elsewhere", async () => {
    const { plain } = await seed();
    stubUpstream(JSON.stringify({ error: { message: "quota exceeded" } }), 429);

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi" }),
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("upstream_error");
    expect(calls).toHaveLength(1);
  });

  it("carries a truncated answer as incomplete rather than complete", async () => {
    // `MAX_TOKENS` means the model was cut off. Calling that "completed" is
    // how a client ends up believing it has the whole answer.
    const { plain } = await seed();
    stubUpstream(
      JSON.stringify({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "half an ans" }] },
            finishReason: "MAX_TOKENS",
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      }),
    );

    const res = await responsesPOST(
      new Request("http://localhost:3000/v1/responses", {
        method: "POST",
        headers: bearer(plain),
        body: JSON.stringify({ model: "client-m", input: "hi" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; output_text: string };
    expect(body.status).toBe("incomplete");
    expect(body.output_text).toBe("half an ans");
  });
});
