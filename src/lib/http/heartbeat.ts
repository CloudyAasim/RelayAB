/**
 * src/lib/http/heartbeat.ts
 *
 * Answering a slow JSON call without letting an idle proxy kill it.
 *
 * A vendor that needs six minutes for a 4K frame produces no bytes for six
 * minutes, and every proxy between us and the client measures *idle* time, not
 * total time. Hiring a bigger number in nginx cannot fix that for a proxy we do
 * not own; sending something is the only thing that can.
 *
 * So once a call passes `HEARTBEAT_AFTER_MS`, the response commits to `200` and
 * streams a space every `HEARTBEAT_INTERVAL_MS` until the real body is ready.
 * A space is significant whitespace in JSON, so the document a client finally
 * parses is byte-for-byte the same shape as a plain answer — `json()` does not
 * care how many spaces precede the `{`.
 *
 * **The trade-off, stated plainly:** once the headers are out, the status is
 * fixed. A call that fails after the threshold therefore arrives as a `200`
 * whose body is the usual error envelope. That is worse for a strict client than
 * a clean `502` — and better than the alternative, which was a proxy timeout
 * with no body at all after six minutes of work. Fast calls never take this path:
 * they settle before the threshold and keep their real status.
 */
import { HEARTBEAT_AFTER_MS, HEARTBEAT_INTERVAL_MS } from "@/lib/protocol/limits";

const PENDING: unique symbol = Symbol("pending");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A heartbeat timer must not by itself keep the process alive under test.
    timer.unref?.();
  });

export interface HeartbeatOptions {
  /** How long the call may take before the response starts streaming. */
  afterMs?: number;
  /** Gap between keep-alive bytes. Must be under the shortest proxy idle window. */
  intervalMs?: number;
}

/**
 * Run `work`; answer normally if it settles quickly, heartbeat if it does not.
 *
 * `work` must resolve to a JSON response — the leading whitespace and the
 * `application/json` content type are the contract here.
 */
export async function respondWithHeartbeat(
  work: Promise<Response>,
  options: HeartbeatOptions = {},
): Promise<Response> {
  const afterMs = options.afterMs ?? HEARTBEAT_AFTER_MS;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  const early = await Promise.race<Response | typeof PENDING>([
    work,
    sleep(afterMs).then(() => PENDING),
  ]);
  if (early !== PENDING) return early;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /**
       * The first beat goes out immediately.
       *
       * Node buffers response headers until the first body write, so waiting
       * `intervalMs` before the first byte means a call that finishes inside
       * that window sends nothing at all — headers included — and the proxy sees
       * a silent request for the whole wait. Measured: a 25 s call with a 15 s
       * interval produced zero beats and a 25 s time-to-first-byte.
       */
      controller.enqueue(encoder.encode(" ".repeat(1024)));

      const ticker = setInterval(() => {
        // 1 KB of spaces: JSON-significant, and large enough that an
        // intermediary with a small buffer still has to forward it.
        controller.enqueue(encoder.encode(" ".repeat(1024)));
      }, intervalMs);
      ticker.unref?.();

      try {
        const response = await work;
        controller.enqueue(encoder.encode(await response.text()));
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              error: {
                message: err instanceof Error ? err.message : String(err),
                type: "server_error",
                code: "upstream_error",
              },
            }),
          ),
        );
      } finally {
        clearInterval(ticker);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // So an operator looking at a six-minute request knows why it is 200
      // with whitespace in front of the body.
      "X-Relay-Heartbeat": "1",
      /**
       * Two headers that exist so the heartbeat actually leaves the process.
       *
       * - `no-transform` stops the app's own compression middleware from
       *   buffering a 1 KB write until its zlib window fills (`compression`
       *   honours this directive).
       * - `X-Accel-Buffering: no` is nginx's switch for "do not buffer this
       *   upstream response" — without it `proxy_buffering` holds the beats and
       *   forwards them when the response *ends*, which is precisely too late.
       */
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
