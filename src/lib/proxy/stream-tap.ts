/**
 * src/lib/proxy/stream-tap.ts
 *
 * SSE passthrough with guaranteed settlement.
 *
 * The streaming proxies forward the upstream body byte-for-byte while
 * scanning it for usage (or accumulated text, when no usage frame arrives).
 * Billing must happen exactly once per request, no matter how the stream
 * ends:
 *
 *   1. normally            — upstream closed the stream
 *   2. consumer cancelled  — the client went away and the response body was
 *                            cancelled
 *   3. request aborted     — `Request.signal` fired
 *
 * A plain `pipeThrough(new TransformStream(...))` only covers (1): its
 * `flush()` never runs when the readable side is cancelled, so an aborted
 * request was silently free. This helper wires all three to a single
 * idempotent `settle()` call.
 */

export interface SseTapOptions {
  /** Called for every complete line (without its trailing newline). */
  onLine: (line: string) => void;
  /**
   * Called once, after the final partial line has been delivered to `onLine`,
   * and before `settle()`. Use it to dispatch a trailing event whose blank
   * separator never arrived.
   */
  onEnd?: () => void;
  /** Idempotent settlement (billing). Invoked at most once. */
  settle: () => Promise<void> | void;
  /** `Request.signal` of the incoming client request, when available. */
  signal?: AbortSignal;
  /** Optional hook for tests/telemetry: which path ended the stream. */
  onEndReason?: (reason: "complete" | "cancelled" | "aborted") => void;
}

export function ssePassthrough(
  source: ReadableStream<Uint8Array>,
  opts: SseTapOptions,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const reader = source.getReader();
  let pending = "";
  let settled = false;

  const settleOnce = async (reason: "complete" | "cancelled" | "aborted"): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      opts.onEndReason?.(reason);
      // The abrupt paths already pushed their trailing partial line through
      // `onLine`; `onEnd` exists so a caller can dispatch a final event whose
      // blank-line separator never arrived.
      opts.onEnd?.();
      await opts.settle();
    } catch (err) {
      // Billing failures must never surface as stream errors to the client.
      console.error("[relayab] stream settle failed:", err);
    }
  };

  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
    void settleOnce("aborted");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const cleanup = (): void => {
    opts.signal?.removeEventListener("abort", onAbort);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        cleanup();
        await settleOnce("cancelled");
        controller.error(err);
        return;
      }

      if (result.done) {
        pending += decoder.decode();
        if (pending) {
          opts.onLine(pending);
          pending = "";
        }
        cleanup();
        await settleOnce("complete");
        controller.close();
        return;
      }

      pending += decoder.decode(result.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        opts.onLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      controller.enqueue(result.value);
    },

    async cancel(reason) {
      cleanup();
      // Deliver whatever partial frame we hold, then bill.
      if (pending) {
        opts.onLine(pending);
        pending = "";
      }
      try {
        await reader.cancel(reason);
      } catch {
        /* the source may already be gone */
      }
      await settleOnce("cancelled");
    },
  });
}
