/**
 * src/instrumentation.ts
 *
 * Where the realtime bridge is installed.
 *
 * ## Why an instrumentation hook
 *
 * `/v1/realtime` is a WebSocket, and a Next.js route handler cannot see the
 * socket an HTTP request arrived on — the runtime owns it. So the upgrade is
 * taken over by the custom server (`server.mjs`), which does have the socket.
 *
 * The two halves have to meet, and the meeting place cannot be an HTTP
 * request: Next.js buffers the request body of every request when a
 * middleware exists, and a realtime session's body — the client's frames —
 * never ends. The session would wait for a body that only ends when the
 * client leaves.
 *
 * So they meet in the process instead. This hook runs while the application
 * starts, in the same process as the custom server, and puts the bridge
 * where the custom server can find it (see `lib/realtime/bridge.ts`).
 *
 * The edge runtime gets its own bundle of this file, and there is nothing for
 * it to do: the realtime surface is a Node-runtime thing.
 */
export async function register(): Promise<void> {
  // The positive form on purpose: `process.env.NEXT_RUNTIME` is replaced at
  // build time, so the edge bundle drops this branch — and with it the
  // bridge, which reaches for `node:crypto` and has no business in a runtime
  // that does not have Node.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installRealtimeBridge } = await import("@/lib/realtime/bridge");
    installRealtimeBridge();
  }
}
