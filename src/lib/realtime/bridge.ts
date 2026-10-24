/**
 * src/lib/realtime/bridge.ts
 *
 * The bridge between a WebSocket socket and a realtime session.
 *
 * ## Why there is no HTTP hop
 *
 * The obvious way to get a socket into the application is over HTTP: the
 * custom server forwards the client's bytes as a request body and the
 * application's answer comes back as a response body. That was the first
 * design here, and it does not work — Next.js buffers the request body of
 * every request when a middleware exists, and a realtime session's body never
 * ends. The handler would wait for a body that only ends when the client
 * leaves, and the client would wait for the handler.
 *
 * So the session does not travel over HTTP at all. It runs in this process,
 * next to the custom server, and the two talk over a pair of streams: the
 * client's bytes go in one end, the frames come out the other.
 *
 * ## How the two halves find each other
 *
 * Through `globalThis`. The custom server (`server.mjs`) cannot import the
 * application's TypeScript — the modules use path aliases and syntax that
 * only Next's own compiler handles — but it shares a process with them, and a
 * process shares one `globalThis`. The instrumentation hook installs the
 * bridge there when the application starts (see `src/instrumentation.ts`), and
 * the custom server picks it up.
 *
 * That is the same pattern the database connection uses, and for the same
 * reason: two entry points, one process, one shared instance.
 */

import { Duplex } from "node:stream";
import {
  FrameParser,
  OPCODE,
  buildHandshakeResponse,
  encodeClosePayload,
  encodeFrame,
  type ParsedFrame,
} from "../ws/frames";

/** What the custom server asks for: an upgrade, and the headers it carries. */
export interface RealtimeOpenRequest {
  /** The upgrade request's headers. */
  headers: Record<string, string | string[] | undefined>;
  /** The upgrade request's URL, query string included. */
  url: string;
}

/** What the bridge answers with. */
export type RealtimeOpenResult =
  /** The session refused to start: an HTTP answer, with a reason. */
  | { ok: false; status: number; body: string }
  /** The session started: the handshake head, and the frame stream. */
  | { ok: true; head: string; frames: Duplex };

/** The shape the custom server finds on `globalThis`. */
export interface RealtimeBridge {
  open(request: RealtimeOpenRequest): Promise<RealtimeOpenResult>;
}

const BRIDGE_KEY = "__relayabRealtimeBridge";

interface BridgeGlobals {
  [BRIDGE_KEY]?: RealtimeBridge;
}

/**
 * Put the bridge where the custom server can find it.
 *
 * Called once, when the application starts.
 */
export function installRealtimeBridge(): void {
  const g = globalThis as unknown as BridgeGlobals;
  if (g[BRIDGE_KEY]) return;
  g[BRIDGE_KEY] = { open: openRealtimeSession };
}

/**
 * Open a realtime session for one upgrade.
 *
 * The heavy modules are imported here rather than at the top of the file on
 * purpose: this runs inside the application, where the framework's own
 * modules are already loaded, and importing them at module scope would mean
 * loading them while the framework is still starting up.
 */
export async function openRealtimeSession(
  request: RealtimeOpenRequest,
): Promise<RealtimeOpenResult> {
  const [{ authenticateBearer, reasonToHttp }, { findOpenAIProvidersForModelUncached }, { getUserById }, { RealtimeSession }] =
    await Promise.all([
      import("../auth/apikey"),
      import("../db/providers"),
      import("../db/users"),
      import("./session"),
    ]);

  // 1. The handshake needs the client's key; without it there is nothing to
  //    answer with.
  const secKey = headerValue(request.headers["sec-websocket-key"]);
  if (!secKey) {
    return httpError(400, "bad_request", "Missing Sec-WebSocket-Key");
  }

  // 2. The model the client asked for. The Realtime API carries it in the
  //    query string of the upgrade.
  const url = new URL(request.url, "http://localhost");
  const model = url.searchParams.get("model") ?? "";
  if (!model) {
    return httpError(
      400,
      "missing_model",
      "The realtime session needs a model (ws://host/v1/realtime?model=…)",
    );
  }

  // 3. Authenticate — the same rules as every other surface.
  const authHeader = resolveAuthHeader(request.headers, url);
  const auth = await authenticateBearer({ authHeader, requestedModel: model });
  if (!auth.ok || !auth.key) {
    const http = reasonToHttp(auth.reason);
    return httpError(http.status, http.code, http.message);
  }
  const user = auth.user ?? (await getUserById(auth.key.userId));
  if (!user) {
    return httpError(403, "user_not_found", "The account owning this key no longer exists");
  }

  // 4. The row that serves the model. The pivot needs an OpenAI face — any
  //    dialect will do, because the request is rewritten into whatever the
  //    vendor speaks.
  const provider = findOpenAIProvidersForModelUncached(model)[0];
  if (!provider) {
    return httpError(400, "model_not_mapped", `No provider configured for model '${model}'`);
  }

  // 5. The stream. Everything the client says arrives as bytes; everything the
  //    session says leaves as bytes.
  let session: InstanceType<typeof RealtimeSession>;
  const frames = new Duplex({
    read() {
      /* the readable side is fed by push() */
    },
    write(chunk, _encoding, callback) {
      try {
        for (const frame of parser.push(Buffer.from(chunk))) handleFrame(frame);
        callback();
      } catch (err) {
        // A protocol violation: the connection cannot continue.
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    final(callback) {
      session.abort();
      callback();
    },
  });

  const parser = new FrameParser();

  const send = (event: Record<string, unknown>): void => {
    const payload = Buffer.from(JSON.stringify(event), "utf8");
    try {
      frames.push(encodeFrame(OPCODE.TEXT, payload));
    } catch {
      // The client is gone: the stream has been closed and there is nobody
      // left to push to.
    }
  };

  const handleFrame = (frame: ParsedFrame): void => {
    if (frame.opcode === OPCODE.TEXT) {
      void session.handleRaw(frame.payload.toString("utf8"));
      return;
    }
    if (frame.opcode === OPCODE.PING) {
      frames.push(encodeFrame(OPCODE.PONG, frame.payload));
      return;
    }
    if (frame.opcode === OPCODE.CLOSE) {
      frames.push(encodeFrame(OPCODE.CLOSE, encodeClosePayload(1000)));
      frames.push(null);
      session.abort();
    }
  };

  session = new RealtimeSession({
    apiKey: auth.key,
    user,
    provider,
    model,
    sessionId: `rt_${Math.random().toString(36).slice(2, 12)}`,
    send,
    resolve: async (nextModel) => {
      // A model is not a provider: the row is looked up again, and the key is
      // checked again, because the key may not be allowed to use the new one.
      const again = await authenticateBearer({ authHeader, requestedModel: nextModel });
      if (!again.ok) {
        const http = reasonToHttp(again.reason);
        return { ok: false, error: { code: http.code, message: http.message } };
      }
      const row = findOpenAIProvidersForModelUncached(nextModel)[0];
      if (!row) {
        return {
          ok: false,
          error: {
            code: "model_not_mapped",
            message: `No provider configured for model '${nextModel}'`,
          },
        };
      }
      return { ok: true, provider: row };
    },
  });

  session.greet();

  // 6. The handshake head. A subprotocol the client asked for is echoed back,
  //    because a client that asked for one and did not get it treats the
  //    handshake as failed.
  const extraHeaders: Record<string, string> = {};
  const subprotocol = headerValue(request.headers["sec-websocket-protocol"]);
  if (subprotocol) extraHeaders["Sec-WebSocket-Protocol"] = subprotocol;

  return { ok: true, head: buildHandshakeResponse(secKey, extraHeaders), frames };
}

/** The bridge the custom server looks for, or null when it is not installed. */
export function realtimeBridge(): RealtimeBridge | null {
  const g = globalThis as unknown as BridgeGlobals;
  return g[BRIDGE_KEY] ?? null;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The key, in whichever carrier it arrived in.
 *
 * The same order the HTTP surfaces use: the Authorization header first, then
 * the Anthropic-style header, then the query parameter.
 */
function resolveAuthHeader(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
): string | null {
  const authorization = headerValue(headers["authorization"]).trim();
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization;

  const xApiKey = headerValue(headers["x-api-key"]).trim();
  if (xApiKey) return `Bearer ${xApiKey}`;

  const queryKey = url.searchParams.get("api_key") ?? "";
  if (queryKey) return `Bearer ${queryKey}`;

  return authorization || null;
}

function httpError(status: number, code: string, message: string): RealtimeOpenResult {
  return {
    ok: false,
    status,
    body: JSON.stringify({ error: { code, message } }),
  };
}
