/**
 * tests/unit/realtime-bridge.test.ts
 *
 * The bridge between a socket and a session.
 *
 * The bridge is what the custom server calls when a client upgrades, so what
 * is pinned here is what it answers with: a handshake head and a stream when
 * the session may start, and an HTTP error when it may not.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createApiKey } from "@/lib/db/keys";
import { createUser } from "@/lib/db/users";
import { createProvider } from "@/lib/db/providers";
import { openRealtimeSession } from "@/lib/realtime/bridge";
import { FrameParser, OPCODE, type ParsedFrame } from "@/lib/ws/frames";

const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

async function setup() {
  const user = await createUser({
    username: "bridge-" + Math.random().toString(36).slice(2, 8),
    password: "x",
    quotaType: "credits",
    quotaLimit: 1000,
    allowedModels: [],
  });
  const created = await createApiKey({ userId: user!.id, label: "l" });
  await createProvider({
    name: "Mock-" + Math.random().toString(36).slice(2, 6),
    kind: "openai",
    baseUrl: "https://api.example.test/v1",
    apiKey: "sk-upstream",
    modelMapping: { "mock-model": "mock-model" },
    upstreamFormat: "responses",
  });
  return created.plainKey;
}

/**
 * A client frame, masked the way RFC 6455 §5.3 says a client must.
 *
 * The bridge's reader insists on the mask bit — that is the statement of which
 * side is speaking — so a test that skipped it would be testing a frame the
 * bridge is right to refuse.
 */
function clientFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from([0x80 | OPCODE.TEXT, 0x80 | data.length]), mask, masked]);
}

/**
 * Collect the frames the bridge writes.
 *
 * The stream never ends on its own — a session lasts as long as the client —
 * so the frames are collected as they arrive rather than read to the end.
 */
function collectFrames(frames: NodeJS.ReadableStream): {
  seen: ParsedFrame[];
  settle: () => Promise<void>;
} {
  const parser = new FrameParser({ requireMask: false });
  const seen: ParsedFrame[] = [];
  frames.on("data", (chunk: Buffer) => {
    seen.push(...parser.push(chunk));
  });
  return {
    seen,
    settle: () => new Promise((resolve) => setTimeout(resolve, 50)),
  };
}

describe("opening a realtime session", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("refuses without a websocket key", async () => {
    const result = await openRealtimeSession({ headers: {}, url: "/v1/realtime?model=mock-model" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toContain("Sec-WebSocket-Key");
  });

  it("refuses without a model", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: { authorization: `Bearer ${key}`, "sec-websocket-key": WS_KEY },
      url: "/v1/realtime",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toContain("model");
  });

  it("refuses a key that is not real", async () => {
    const result = await openRealtimeSession({
      headers: { authorization: "Bearer sk-not-a-key", "sec-websocket-key": WS_KEY },
      url: "/v1/realtime?model=mock-model",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });

  it("refuses a model nobody serves", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: { authorization: `Bearer ${key}`, "sec-websocket-key": WS_KEY },
      url: "/v1/realtime?model=nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(400);
    expect(result.body).toContain("model_not_mapped");
  });

  it("answers a good upgrade with a handshake head and a stream", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: { authorization: `Bearer ${key}`, "sec-websocket-key": WS_KEY },
      url: "/v1/realtime?model=mock-model",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.head).toContain("101 Switching Protocols");
    expect(result.head).toContain("Sec-WebSocket-Accept:");
    expect(result.frames).toBeTruthy();
  });

  it("echoes a subprotocol the client asked for", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: {
        authorization: `Bearer ${key}`,
        "sec-websocket-key": WS_KEY,
        "sec-websocket-protocol": "realtime",
      },
      url: "/v1/realtime?model=mock-model",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.head).toContain("Sec-WebSocket-Protocol: realtime");
  });

  it("greets the client as soon as the session is open", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: { authorization: `Bearer ${key}`, "sec-websocket-key": WS_KEY },
      url: "/v1/realtime?model=mock-model",
    });
    if (!result.ok) throw new Error("unreachable");

    const { seen, settle } = collectFrames(result.frames);
    await settle();

    const first = seen[0];
    expect(first?.opcode).toBe(OPCODE.TEXT);
    const event = JSON.parse(first!.payload.toString("utf8")) as { type: string };
    expect(event.type).toBe("session.created");
  });

  it("answers a ping with a pong", async () => {
    const key = await setup();
    const result = await openRealtimeSession({
      headers: { authorization: `Bearer ${key}`, "sec-websocket-key": WS_KEY },
      url: "/v1/realtime?model=mock-model",
    });
    if (!result.ok) throw new Error("unreachable");

    const parser = new FrameParser({ requireMask: false });
    const seen: ParsedFrame[] = [];
    result.frames.on("data", (chunk: Buffer) => {
      seen.push(...parser.push(chunk));
    });

    // A ping frame, masked like any other client frame.
    const mask = Buffer.from([9, 9, 9, 9]);
    const ping = Buffer.concat([
      Buffer.from([0x80 | OPCODE.PING, 0x80]),
      mask,
    ]);
    result.frames.write(ping);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const pong = seen.find((f) => f.opcode === OPCODE.PONG);
    expect(pong, "the client pinged and nothing ponged back").toBeTruthy();
  });
});
