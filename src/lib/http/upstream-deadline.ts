/**
 * src/lib/http/upstream-deadline.ts
 *
 * How long an upstream may stay silent before the relay gives up — and why the
 * stream is not cut when it starts talking.
 *
 * The text protocol has had a `limits.timeoutMs` in every spec since it was
 * written, validated as "a positive whole number", and **nothing ever read it**
 * (2026-11-13, 08 §90.3). Media and search enforce theirs; text did not, so a
 * provider whose upstream never answers held the request open until the client
 * gave up.
 *
 * Enforcing it on the whole response would be wrong for this surface: a chat
 * answer is a *stream*, and a spec that allows 120s to start answering does not
 * mean "cut the answer at two minutes". So the timer covers **until the headers
 * arrive** and is cleared the moment they do; after that only the caller matters
 * (a client that disconnects still aborts the body).
 */
export interface UpstreamDeadline {
  /** Pass to `fetch`; `undefined` when the spec declared no timeout. */
  signal?: AbortSignal;
  /** Stop the timer. Call as soon as the response's headers have arrived. */
  done: () => void;
}

/**
 * A deadline for the upstream's *headers*, combined with the caller's signal.
 *
 * `timeoutMs` is the value from the provider's text spec (`limits.timeoutMs`).
 * A missing or nonsensical value means "no deadline", not "zero timeout".
 */
export function upstreamDeadline(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): UpstreamDeadline {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ...(caller ? { signal: caller } : {}), done: () => {} };
  }

  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort(
      new Error(`upstream did not respond within ${timeoutMs}ms (spec limits.timeoutMs)`),
    );
  }, timeoutMs);
  // A pending deadline must not keep the process alive on its own.
  handle.unref?.();

  return {
    signal: caller ? AbortSignal.any([caller, timer.signal]) : timer.signal,
    done: () => clearTimeout(handle),
  };
}
