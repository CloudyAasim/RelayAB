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
): ReadableStream<Uint8Array> {  const decoder = new TextDecoder();
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

/**
 * Rewrite an SSE stream's lines as they go by.
 *
 * The difference from {@link ssePassthrough}: that one *watches* the bytes and
 * forwards them untouched, this one *replaces* them. It is what a surface
 * needs when the client asked for one dialect and the upstream answered in
 * another — the frames have to change shape on the way out.
 *
 * `map` is called once per complete line, without its trailing newline, and
 * returns the line(s) that replace it. `null` drops the line; a string
 * replaces it with itself plus the newline; an array replaces it with several.
 *
 * **The settlement is the source's, not this one's.** The stream being
 * rewritten settles its own usage when it ends, and this wrapper only reads
 * from it — so the billing still happens exactly once, when the upstream
 * finishes. Nothing here bills anything.
 */
export function sseRewrite(
  source: ReadableStream<Uint8Array>,
  opts: {
    map: (line: string) => string | string[] | null;
    /**
     * Called once, after the last line has been mapped.
     *
     * It may return lines of its own, which is how a surface sends the final
     * frame of a stream — the one carrying the usage and the reason it
     * stopped — when the upstream had no such frame to rewrite.
     */
    onEnd?: () => string | string[] | null;
    signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = source.getReader();
  let pending = "";

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, line: string): void => {
    // The blank line is the frame separator, and it is the frame's structure
    // rather than its content: dropping it would run every frame into one.
    if (line.trim().length === 0) {
      controller.enqueue(encoder.encode("\n"));
      return;
    }
    const mapped = opts.map(line);
    if (mapped === null) return;
    const lines = Array.isArray(mapped) ? mapped : [mapped];
    for (const out of lines) {
      controller.enqueue(encoder.encode(`${out}\n`));
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        controller.error(err);
        return;
      }

      if (result.done) {
        pending += decoder.decode();
        if (pending) {
          emit(controller, pending);
          pending = "";
        }
        const tail = opts.onEnd?.();
        if (tail) {
          const lines = Array.isArray(tail) ? tail : [tail];
          for (const out of lines) {
            controller.enqueue(encoder.encode(`${out}\n`));
          }
          // The closing frame needs its separator too, or the last frame runs
          // into nothing and a client waiting for a blank line waits forever.
          controller.enqueue(encoder.encode("\n"));
        }
        controller.close();
        return;
      }

      pending += decoder.decode(result.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        emit(controller, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },

    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* the source may already be gone */
      }
    },
  });
}
