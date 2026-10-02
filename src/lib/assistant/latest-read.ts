/**
 * src/lib/assistant/latest-read.ts
 *
 * "Only the newest read counts", for the transcript.
 *
 * Reading a thread happens from three independent places in the same turn: the
 * effect that follows `threadId` and `busy`, the explicit reload when a turn
 * settles, and the `setThreadId` that the response headers cause. They are
 * separate fetches, and the server answers them in whatever order it finishes
 * — so the request issued *first* can land *last* and overwrite the transcript
 * with a version from before the last reply was written.
 *
 * The symptom is not obviously a race. The answer looks complete as it streams
 * in, and then quietly loses its tail as a stale response replaces it; a
 * refresh — which is just a later read — brings it back. So it reads as "the
 * server stopped early" rather than as "the browser applied an old answer".
 *
 * A sequence number is enough: a read that has been overtaken is not an error,
 * it is simply no longer the one anyone wants.
 */
export interface LatestRead {
  /** Claim a read. Returns a token to pass back to `accept`. */
  begin(): number;
  /** Is this still the newest read? */
  accept(token: number): boolean;
}

export function latestRead(): LatestRead {
  let seq = 0;
  return {
    begin: () => ++seq,
    accept: (token: number) => token === seq,
  };
}
