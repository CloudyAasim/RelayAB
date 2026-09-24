/**
 * Responses surface: protocol fallback when the native endpoint is broken.
 *
 * Regression context: Agnes advertises a Responses API in its docs, but
 * POST https://api.agnes-ai.cn/v1/responses answers HTTP 500 for every request
 * body (string input, message array, with/without instructions - all probed
 * against the real endpoint). Setting upstreamFormat "responses" on that
 * provider therefore made every Codex call fail with
 * "502 Bad Gateway: Upstream returned 500".
 *
 * /v1/responses now tries the available protocols in fidelity order
 * (native Responses, then the Chat Completions conversion, then the Anthropic
 * conversion) and only gives up when all of them fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetRedisForTest, __setRedisForTest } from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";

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
  content: [{ type: "text", text: "via anthropic" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 6 },
});

const NATIVE_JSON = JSON.stringify({
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "up-model",
  output: [
    {
      id: "resp_1_msg",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "native", annotations: [] }],
    },
  ],
  output_text: "native",
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
});

let apiKeyPlain = "";
let apiKeyId = "";
let calls: string[] = [];

/** Upstream stub keyed by URL, so each protocol can fail independently. */
function stubUpstream(route: (url: string) => Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      return route(u);
    }),
  );
}

const ok = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const broken = () =>
  new Response(JSON.stringify({ error: { message: "native responses endpoint is broken" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

async function seedUserAndKey(): Promise<void> {
  const user = await createUser({
    username: "fb-" + Math.random().toString(36).slice(2, 6),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user.id, label: "l" });
  apiKeyPlain = created.plainKey;
  apiKeyId = created.key.id;
}

async function seedProvider(
  name: string,
  upstreamFormat: "responses" | "chat" | "anthropic",
  baseUrl: string,
): Promise<void> {
  await createProvider({
    name,
    kind: "openai",
    baseUrl,
    apiKey: "sk-upstream",
    enabled: true,
    upstreamFormat,
    modelMapping: { "client-m": "up-model" },
  });
}

function request(): Request {
  return new Request("http://localhost:3000/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyPlain}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "client-m", input: "hi" }),
  });
}

describe("/v1/responses protocol fallback", () => {
  beforeEach(() => {
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the Anthropic provider when the native endpoint 500s", async () => {
    await seedUserAndKey();
    await seedProvider("Agnes CN", "responses", "https://agnes.test/v1");
    await seedProvider("Agnes CN Anthropic", "anthropic", "https://agnes.test");
    stubUpstream((u) => (u.endsWith("/v1/messages") ? ok(ANTHROPIC_JSON) : broken()));

    const res = await responsesPOST(request());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.output_text).toBe("via anthropic");
    expect(calls).toEqual([
      "https://agnes.test/v1/responses",
      "https://agnes.test/v1/messages",
    ]);
  });

  it("falls back to the Chat Completions conversion for a lone broken native provider", async () => {
    await seedUserAndKey();
    await seedProvider("Lone Native", "responses", "https://lone.test/v1");
    stubUpstream((u) => (u.endsWith("/chat/completions") ? ok(CHAT_JSON) : broken()));

    const res = await responsesPOST(request());

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).output_text).toBe("via chat");
    expect(calls).toEqual([
      "https://lone.test/v1/responses",
      "https://lone.test/v1/chat/completions",
    ]);
  });

  it("tries the chat provider when a broken native provider is listed first", async () => {
    await seedUserAndKey();
    await seedProvider("A Chat", "chat", "https://chat.test/v1");
    await seedProvider("Z Native", "responses", "https://native.test/v1");
    stubUpstream((u) => (u.startsWith("https://chat.test") ? ok(CHAT_JSON) : broken()));

    const res = await responsesPOST(request());

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      "https://native.test/v1/responses",
      "https://chat.test/v1/chat/completions",
    ]);
  });

  it("records exactly one error row, with the upstream detail, when every protocol fails", async () => {
    await seedUserAndKey();
    await seedProvider("All Broken", "responses", "https://dead.test/v1");
    stubUpstream(() => broken());

    const res = await responsesPOST(request());

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_error");
    // The upstream's own words stay out of the client response ...
    expect(JSON.stringify(body)).not.toContain("native responses endpoint is broken");

    // ... but land on the single usage row, with the URL that failed.
    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].errorMessage).toContain("https://dead.test/v1/responses");
    expect(logs[0].errorMessage).toContain("HTTP 500");
  });

  it("does not fall back when the native endpoint already works", async () => {
    await seedUserAndKey();
    await seedProvider("Good Native", "responses", "https://good.test/v1");
    await seedProvider("Spare Anthropic", "anthropic", "https://spare.test");
    stubUpstream(() => ok(NATIVE_JSON));

    const res = await responsesPOST(request());

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).output_text).toBe("native");
    expect(calls).toEqual(["https://good.test/v1/responses"]);

    const logs = await listUsageByKey(apiKeyId);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("success");
  });
});
