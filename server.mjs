/**
 * server.mjs
 *
 * The custom server. It exists for one reason: `/v1/realtime` is a WebSocket,
 * and a Next.js route handler cannot see the socket an HTTP request arrived
 * on — the runtime owns it. So the upgrade is taken over here, where the raw
 * socket is, and everything else is handed to Next unchanged.
 *
 * ## What this file knows about the protocol
 *
 * Nothing. The handshake head is computed by the bridge (the application
 * side, `lib/realtime/bridge.ts`) and the frames are produced there too: this
 * file connects a socket to a stream and moves bytes.
 *
 * The bridge lives in this same process — the custom server *is* the Next
 * server — and the two find each other through `globalThis`, which the
 * application's instrumentation hook fills when the application starts.
 *
 * ## Why the session is not reached over HTTP
 *
 * It was, in the first design, and it does not work: Next.js buffers the
 * request body of every request when a middleware exists, and a realtime
 * session's body is the client's frames, which never ends. The handler would
 * wait for a body that only ends when the client leaves.
 *
 * ## The token
 *
 * There is none, and there does not need to be: the bridge is only reachable
 * from inside this process.
 */
import http from "node:http";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
/**
 * The address to listen on.
 *
 * `0.0.0.0` rather than `process.env.HOSTNAME`: in a container `HOSTNAME` is
 * the container id, and binding to it would leave the loopback address — which
 * is where the application reaches itself — unbound.
 */
const host = process.env.RELAYAB_HOST ?? "0.0.0.0";

/** The public path of the realtime surface. */
const REALTIME_PATH = "/v1/realtime";
/** Where the bridge puts itself. */
const BRIDGE_KEY = "__relayabRealtimeBridge";

/** The reason phrases for the answers this server writes itself. */
const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

await app.prepare();

// After `prepare()`: the upgrade handler belongs to the server Next has now
// built, and asking for it earlier is an error rather than a null.
const handleUpgrade = app.getUpgradeHandler();

/**
 * The plain-HTTP answer for the realtime path.
 *
 * The path is a WebSocket, and a request that is not an upgrade gets the
 * status that says so — with the header that says how to reach it.
 *
 * It is answered here rather than by a route handler for a reason that is not
 * cosmetic: a route handler *at this path* would also match the upgrade.
 * Next.js resolves the rewrite, finds the route, and ends the socket — and
 * that socket is this one, mid-handshake.
 */
function upgradeRequired(res) {
  const body = JSON.stringify({
    error: {
      code: "upgrade_required",
      type: "invalid_request_error",
      message:
        "This endpoint is a WebSocket. Connect to it with an Upgrade: websocket " +
        "handshake (for example ws://host/v1/realtime?model=<model>).",
    },
  });
  res.writeHead(426, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    Upgrade: "websocket",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/**
 * Carry one upgraded connection into the session.
 *
 * The bridge answers with the handshake head and a stream. The head is
 * written to the socket first — the client waits for a `101` before it sends
 * anything — and then the two are piped together in both directions.
 */
async function bridgeRealtime(req, socket, head) {
  socket.setNoDelay(true);
  // The session is a conversation that can sit silent for minutes. The
  // timeout that matters is the proxy's read timeout in front of it, not a
  // socket timer here.
  socket.setTimeout(0);

  const bridge = globalThis[BRIDGE_KEY];
  if (!bridge) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }

  let opened;
  try {
    opened = await bridge.open({ headers: req.headers, url: req.url ?? "/" });
  } catch (err) {
    console.error("[relayab] realtime bridge failed:", err);
    socket.end("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
    return;
  }

  if (!opened.ok) {
    const body = Buffer.from(opened.body ?? "", "utf8");
    socket.end(
      `HTTP/1.1 ${opened.status} ${STATUS_TEXT[opened.status] ?? "Error"}\r\n` +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n\r\n" +
        body.toString("utf8"),
    );
    return;
  }

  socket.write(opened.head);
  // The session's frames out, the client's frames in.
  opened.frames.pipe(socket);
  socket.pipe(opened.frames);
  // Bytes the client sent together with the upgrade request.
  if (head && head.length > 0) opened.frames.write(head);
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (path === REALTIME_PATH) {
    upgradeRequired(res);
    return;
  }
  handle(req, res);
});

server.on("clientError", (err, socket) => {
  console.log("[relayab] client error:", err.code, err.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "").split("?")[0];
  if (path !== REALTIME_PATH) {
    // Not ours. Next.js keeps its own upgrade handling (the dev server's
    // hot-reload socket lives here).
    handleUpgrade(req, socket, head);
    return;
  }
  void bridgeRealtime(req, socket, head);
});

/**
 * The request timeout is off.
 *
 * A realtime session is one long request: the body is the client's frames and
 * it never ends, and the client may sit silent between turns for longer than
 * any sensible request timeout. The ceiling that actually applies is the
 * proxy's read timeout in front of the application.
 */
server.requestTimeout = 0;

server.listen(port, host, () => {
  console.log(`> RelayAB ready on http://${host}:${port}`);
});

/**
 * Shut down when the platform says so.
 *
 * Dokku stops an app with SIGTERM and waits for the process to go away, so
 * the listener is closed and the process is given a moment to finish the
 * connections it still has.
 */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
