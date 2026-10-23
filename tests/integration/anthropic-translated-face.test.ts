/**
 * tests/integration/anthropic-translated-face.test.ts
 *
 * The Anthropic **client** surface against a vendor that speaks no Anthropic.
 *
 * The face has two modes, and they are different things rather than two
 * spellings of one:
 *
 *  - **native** — the vendor publishes its own `/v1/messages`, and the request
 *    goes out in Anthropic's shape. This is what the face has always meant.
 *  - **translated** — the vendor speaks no Anthropic, and the gateway rewrites
 *    the request into the protocol it does speak.
 *
 * The choice is the operator's because the gateway cannot know it: guessing
 * would either 404 on a vendor with no Anthropic endpoint, or bypass the
 * endpoint of one that has.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as messagesPOST } from "@/app/api/v1/messages/route";

const CHAT_JSON = JSON.stringify({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "up-model",
  choices: [{ index: 0, message: { role: "assistant", content: "via chat" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
});

const ANTHROPIC_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "up-model",
  content: [{ type: "text", text: "via messages" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 4, output_tokens: 6 },
});

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let calls: UpstreamCall[] = [];

function stubUpstream(body = CHAT_JSON): void {
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
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function seed(mode: "native" | "translated"): Promise<{ plain: string; keyId: string }> {
  const user = await createUser({
    username: "af-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  await createProvider({
    name: "Upstream",
    kind: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat: "chat",
    openaiEnabled: true,
    anthropicEnabled: true,
    anthropicMode: mode,
    modelMapping: { "client-m": "up-model" },
  });
  return { plain: created.plainKey, keyId: created.key.id };
}

function ask(plain: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return messagesPOST(
    new Request("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "x-api-key": plain, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "client-m",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
        ...extra,
      }),
    }),
  );
}

describe("the Anthropic face", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the request as it is, when the vendor serves Anthropic itself", async () => {
    const { plain } = await seed("native");
    stubUpstream(ANTHROPIC_JSON);

    const res = await ask(plain);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0].text).toBe("via messages");

    // The vendor's own endpoint, in Anthropic's own shape.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.test/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("sk-upstream");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(calls[0].body.model).toBe("up-model");
  });

  it("translates the request, when the vendor speaks no Anthropic", async () => {
    const { plain, keyId } = await seed("translated");
    stubUpstream(CHAT_JSON);

    const res = await ask(plain);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    // The answer comes back in Anthropic's shape, because that is what the
    // client asked for.
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]).toEqual({ type: "text", text: "via chat" });
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 6 });

    // And the vendor got a request in the shape it does speak.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.test/v1/chat/completions");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(calls[0].body.model).toBe("up-model");

    // And it was billed once.
    const rows = await listUsageByKey(keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0].promptTokens).toBe(4);
    expect(rows[0].completionTokens).toBe(6);
  });

  it("refuses a model no Anthropic provider serves", async () => {
    const { plain } = await seed("translated");
    stubUpstream();

    const res = await messagesPOST(
      new Request("http://localhost:3000/v1/messages", {
        method: "POST",
        headers: { "x-api-key": plain, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "no-such-model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
