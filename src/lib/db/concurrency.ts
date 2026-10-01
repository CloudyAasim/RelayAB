/**
 * src/lib/db/concurrency.ts
 *
 * Bounded fan-out for the repository layer.
 *
 * The repositories used to read records one at a time (`for … await`), which
 * cost one HTTP round-trip per record and dominated page load time on a
 * REST-backed Redis. Firing everything at once fixes that but is unbounded, so
 * this keeps a fixed width of tasks in flight.
 *
 * No storage changes were needed here: this is a pure function over its inputs
 * and never touched Redis. The original reason for it — 1000 sockets from a key
 * with `MAX_LOGS_PER_KEY` entries — is gone with the REST client, but the callers
 * (`usage.ts` per-key aggregation) still rely on the same three guarantees, so
 * it stays:
 * - bounded work, so a long key list does not become one uninterruptible burst
 *   of synchronous SQLite reads on the shared connection;
 * - results in input order, so callers can zip them back onto their key list
 *   without re-sorting;
 * - fail-fast — the first error stops new work being scheduled, so one bad key
 *   does not fan out the remaining reads before the error surfaces.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  let failure: unknown = null;

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      if (failure) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        // Stop scheduling new work; re-throw once every worker has unwound.
        failure ??= err;
        return;
      }
    }
  });

  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}
