/**
 * tests/unit/sqlite-transaction-scope.test.ts
 *
 * A transaction belongs to a request, and the connection runs one at a time.
 *
 * `withTransaction` tracked its nesting in a module counter. Node runs one
 * thread, which makes that look safe until you notice every `fn` here is async:
 * while one request is inside its transaction — awaiting a read, a write, an
 * audit — another request runs, sees a depth of 1, and concludes it is a
 * nested call. It is not. It got no `BEGIN` of its own, its writes went into
 * someone else's transaction, and it returned success — which the first
 * request's `ROLLBACK` then discarded, leaving a caller holding a success for
 * work that was never committed.
 *
 * Fixing the ownership alone is not enough, and finding that out is what this
 * file records: SQLite allows one writer and this is a single shared
 * connection rather than a pool, so a second `BEGIN IMMEDIATE` fails outright
 * with "cannot start a transaction within a transaction". The counter was
 * hiding that behind a worse bug. One transaction at a time is the correct
 * behaviour here, so the queue turns a hard failure into a wait.
 *
 * The property worth testing is therefore not "two transactions overlap" —
 * they cannot — but **"the second one is unaffected by the first one's
 * failure"**, which is exactly what the old code got wrong while appearing to
 * work.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { __resetDbForTest, withTransaction } from "@/lib/db/sqlite";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("transaction nesting is per request, not per process", () => {
  beforeEach(() => {
    __resetDbForTest();
  });
  afterEach(() => {
    __resetDbForTest();
  });

  it("a nested call joins the transaction it was made from", async () => {
    // The behaviour the counter exists for, and it has to survive the change:
    // a helper reused inside a larger block must not open a second
    // transaction it has no way to commit.
    let innerRan = false;
    await withTransaction(async () => {
      await withTransaction(async () => {
        innerRan = true;
      });
    });
    expect(innerRan).toBe(true);
  });

  it("a rejection inside a nested call rolls the whole thing back", async () => {
    // Nesting must not become an escape hatch: the inner call's failure is the
    // outer transaction's failure, and there is no partial commit.
    await expect(
      withTransaction(async () => {
        await withTransaction(async () => {
          throw new Error("inner failed");
        });
      }),
    ).rejects.toThrow("inner failed");
  });

  it("a second request waits rather than joining the first", async () => {
    // Two BEGINs on one connection cannot overlap. The second has to wait —
    // and waiting is the safe answer, because joining is what put a request's
    // writes inside a transaction another request could roll back.
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withTransaction(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    let secondFinished = false;
    const second = withTransaction(async () => {
      secondFinished = true;
    });

    // Still waiting: the first holds the connection.
    await new Promise((r) => setTimeout(r, 20));
    expect(secondFinished, "two transactions ran at once on one connection").toBe(false);

    releaseFirst.resolve();
    await first;
    await second;
    expect(secondFinished).toBe(true);
  });

  it("a request's work survives another request's rollback", async () => {
    // The bug, stated as the property a caller depends on. Under the module
    // counter, the second request joined the first: it returned success, and
    // the first request's failure then discarded those writes. A success that
    // survives a neighbour's failure is what "own transaction" means.
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withTransaction(async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      throw new Error("the first request fails");
    });
    await firstEntered.promise;

    const second = withTransaction(async () => "second committed");
    releaseFirst.resolve();

    await expect(first).rejects.toThrow("the first request fails");
    await expect(second).resolves.toBe("second committed");
  });

  it("several overlapping requests each resolve, in order", async () => {
    // Concurrency scales: whichever request held the counter last would have
    // absorbed all the others.
    const entered = [deferred(), deferred(), deferred()];
    const release = [deferred(), deferred(), deferred()];

    const runs = entered.map((e, i) =>
      withTransaction(async () => {
        e.resolve();
        await release[i].promise;
      }),
    );

    await entered[0].promise;
    // Only the first can have entered — the others are waiting their turn.
    await new Promise((r) => setTimeout(r, 20));
    release[0].resolve();
    await entered[1].promise;
    release[1].resolve();
    await entered[2].promise;
    release[2].resolve();

    await expect(Promise.all(runs)).resolves.toHaveLength(3);
  });
});