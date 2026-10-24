/**
 * tests/unit/realtime-session.test.ts
 *
 * A realtime session, end to end over the pivot.
 *
 * The session is where a Realtime client meets a vendor that has never heard
 * of a WebSocket: the conversation is turned into a Responses request, the
 * upstream answers in its own dialect, and the answer comes back as Realtime
 * events. These tests pin that round trip — the order of the events, the
 * usage, the billing, and what happens to the events this gateway does not
 * serve.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser, getUserById } from "@/lib/db/users";
import { createProvider, findOpenAIProvidersForModel } from "@/lib/db/providers";
import { listUsageByKey } from "@/lib/db/usage";
import { RealtimeSession } from "@/lib/realtime/session";

const SSE_BODY = [
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"Hel"}',
  "",
  "event: response.output_text.delta",
  'data: {"type":"response.output_text.delta","delta":"lo"}',
  "",
  "event: response.completed",
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":11,"output_tokens":22,"total_tokens":33}}}',
  "",
  "",
].join("\n");

function sseResponse(): Response {
  return new Response(SSE_BODY, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function setup() {
  const u = await createUser({
    username: "rt-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: u.id, label: "l" });
  const user = (await getUserById(u.id))!;
  await createProvider({
    name: "MiniMax-" + Math.random().toString(36).slice(2, 6),
    kind: "openai",
    baseUrl: "https://api.minimax.cn/v1",
    apiKey: "sk-upstream",
    modelMapping: { "MiniMax-M3": "MiniMax-M3" },
    upstreamFormat: "responses",
  });
  const provider = (await findOpenAIProvidersForModel("MiniMax-M3"))[0];
  return { key: created.key, user, provider };
}

function makeSession(
  key: Awaited<ReturnType<typeof createApiKey>>["key"],
  user: Awaited<ReturnType<typeof getUserById>> & object,
  provider: Awaited<ReturnType<typeof findOpenAIProvidersForModel>>[number],
  send: (event: Record<string, unknown>) => void,
  fetchImpl?: typeof fetch,
) {
  return new RealtimeSession({
    apiKey: key,
    user: user as never,
    provider,
    model: "MiniMax-M3",
    sessionId: "rt_test",
    send,
    ...(fetchImpl ? { deps: { fetchImpl } } : {}),
  });
}

describe("a realtime session", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("answers a request with the events a realtime client waits for", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => sseResponse());
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(
      JSON.stringify({
        type: "conversation.item.create",
        item: { role: "user", content: [{ type: "input_text", text: "hi" }] },
      }),
    );
    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "conversation.item.created",
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.done",
    ]);

    // The two deltas arrived as two deltas, not as one answer at the end.
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.map((d) => d.delta)).toEqual(["Hel", "lo"]);

    // The finished response carries the usage the upstream reported.
    const done = events.find((e) => e.type === "response.done");
    expect(done).toMatchObject({
      response: { status: "completed", usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33 } },
    });
  });

  it("sends the conversation upstream, as a Responses request", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => sseResponse());
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(
      JSON.stringify({
        type: "conversation.item.create",
        item: { role: "user", content: [{ type: "input_text", text: "hi" }] },
      }),
    );
    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([{ type: "message", role: "user", content: "hi" }]);
  });

  it("bills the turn", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => sseResponse());
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    const logs = await listUsageByKey(key.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].promptTokens).toBe(11);
    expect(logs[0].completionTokens).toBe(22);
    expect(logs[0].status).toBe("success");
  });

  it("answers an audio event with an error, not with silence", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const session = makeSession(key, user, provider, (e) => events.push(e));

    await session.handleRaw(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { code: "unsupported_event" },
    });
  });

  it("answers a ping with a pong", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const session = makeSession(key, user, provider, (e) => events.push(e));

    await session.handleRaw(JSON.stringify({ type: "ping", event_id: "e1" }));
    expect(events[0]).toEqual({ type: "pong", event_id: "e1" });
  });

  it("remembers the session's instructions", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => sseResponse());
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(
      JSON.stringify({ type: "session.update", session: { instructions: "be brief" } }),
    );
    expect(events[0]).toMatchObject({ type: "session.updated" });

    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).instructions).toBe("be brief");
  });

  it("refuses an audio modality and says so, but keeps serving text", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const session = makeSession(key, user, provider, (e) => events.push(e));

    await session.handleRaw(
      JSON.stringify({ type: "session.update", session: { modalities: ["audio"] } }),
    );

    expect(events[0]).toMatchObject({ type: "error", error: { code: "unsupported_modality" } });
    expect(events[1]).toMatchObject({ type: "session.updated" });
    expect((events[1].session as Record<string, unknown>).modalities).toEqual(["text"]);
  });

  it("keeps the answer in the conversation, so the next turn has the context", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => sseResponse());
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    expect(session.snapshot.items.map((i) => ({ role: i.role, text: i.text }))).toEqual([
      { role: "assistant", text: "Hello" },
    ]);
  });

  it("reports an upstream failure as an error and a failed response", async () => {
    const { key, user, provider } = await setup();
    const events: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const session = makeSession(key, user, provider, (e) => events.push(e), fetchMock as never);

    await session.handleRaw(JSON.stringify({ type: "response.create" }));
    await session.drain();

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.find((e) => e.type === "response.done")).toMatchObject({
      response: { status: "failed" },
    });
  });
});
