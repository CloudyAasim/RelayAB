/**
 * src/lib/http/transport.ts
 *
 * The transport's own timeouts, and why they are switched off.
 *
 * RelayAB relays to vendors it does not control. Node's `fetch` is undici, and
 * undici ships two timers nobody asked for: `headersTimeout` and `bodyTimeout`,
 * both **300 seconds** by default. They are not the vendor's limit, they are not
 * the proxy's limit and they are not the spec's limit — they are a library
 * default that silently killed any media generation slower than five minutes
 * (H3 4K, long video jobs), and it looked exactly like "上游超时".
 *
 * The relay already has an owner for that decision: `limits.timeoutMs` in the
 * spec, enforced per call as an `AbortSignal` (`media/handler.ts`). A transport
 * that also invents deadlines makes the declared one a lie — the 2026-11-13
 * lesson, one layer lower than where it was first noticed.
 *
 * So: no header/body timers (0 disables them in undici), a connect timeout that
 * stays finite (a dead host must fail fast), and every call bounded by its own
 * AbortSignal. `tests/unit/transport-timeouts.test.ts` pins both halves.
 */
import { Agent, setGlobalDispatcher } from "undici";
import { CONNECT_TIMEOUT_MS } from "@/lib/protocol/limits";

let installed = false;

export function installTransportTimeouts(): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(
    new Agent({
      // Disabled on purpose: the caller owns the deadline.
      headersTimeout: 0,
      bodyTimeout: 0,
      // Not disabled: a socket that never connects is a dead host, not a slow
      // generation, and waiting on it for a vendor's whole window helps nobody.
      connectTimeout: CONNECT_TIMEOUT_MS,
    }),
  );
}

/** For tests and for `instrumentation.ts` to assert the wiring. */
export function __resetTransportForTest(): void {
  installed = false;
}
