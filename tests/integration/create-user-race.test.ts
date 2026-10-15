/**
 * tests/integration/create-user-race.test.ts
 *
 * Concurrent `createUser()` must not produce two users with one name.
 *
 * **What this used to test, and why the number changed.** The original version
 * raced twenty callers at it, because the implementation it was written against
 * was Redis and the failure it hunted was a TOCTOU: `GET` the by-username
 * secondary index, find it free, `SET` it — and a second caller arriving in
 * between saw the same "free" and also wrote. Twenty made that window easy to
 * hit. Twenty is also why this file was the one that died: bcrypt at work
 * factor 12 costs about 200 ms each, `bcryptjs` is a pure-JavaScript
 * implementation, and twenty of them at once was enough to push a Vitest worker
 * past its heap. The run reported `Worker exited unexpectedly` and tinypool
 * swallowed it — which is how a memory limit came to be filed as an unrelated
 * flake for however long it went unnoticed.
 *
 * None of that load is needed any more. The store is SQLite, and there the
 * check and the write are one statement against a `UNIQUE` index on `username`
 * (`src/lib/db/users.ts`, "ATOMIC CONFLICT CHECK + INSERT"). A uniqueness
 * constraint does not need twenty chances to be enforced: the second insert is
 * refused by the database itself, and one caller proves that. What twenty was
 * really buying was a better chance of catching the *other* shape of bug — a
 * check-then-write with no constraint behind it — and for that, racing a handful
 * is still ample, because every caller still hashes a password before it reaches
 * the insert and so genuinely overlaps.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { __resetDbForTest } from "@/lib/db/sqlite";
import {
  createUser,
  getUserByUsername,
  listUsers,
  UsernameConflictError,
} from "@/lib/db/users";

// bcrypt at work factor 12 is ~200ms per call, and the callers below overlap
// deliberately — so this stays comfortably over the vitest default of 5s.
const STRESS_TIMEOUT_MS = 30_000;

/**
 * How many callers to race.
 *
 * Enough that every one of them is past its password hash while the others are
 * still hashing — that is the overlap the test is about — and small enough that
 * the whole set fits in a worker's heap with the rest of the suite.
 */
const RACERS = 6;

describe("createUser race protection", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it(
    `${RACERS} concurrent createUser('admin') → exactly one succeeds`,
    async () => {
      const attempts = Array.from({ length: RACERS }, () =>
        createUser({ username: "admin", password: "longenoughpw" })
          .then((u) => ({ ok: true as const, user: u }))
          .catch((err) => ({
            ok: false as const,
            isConflict: err instanceof UsernameConflictError,
            error: err,
          })),
      );
      const results = await Promise.all(attempts);

      const successes = results.filter((r) => r.ok);
      const conflicts = results.filter((r) => !r.ok && r.isConflict);

      expect(successes).toHaveLength(1);
      // Derived rather than spelled out. When this was twenty callers the
      // number was written as `19`, and lowering the count to six left it
      // behind — so the assertion kept asking a question about a race that no
      // longer existed, and the file failed for a reason that had nothing to do
      // with the thing it is guarding.
      expect(conflicts).toHaveLength(RACERS - 1);

      // Exactly one user record exists in the database.
      const fetched = await getUserByUsername("admin");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(successes[0]!.user.id);

      // listUsers confirms only one user with that username.
      const { users } = await listUsers({ limit: 200 });
      expect(users.filter((u) => u.username === "admin")).toHaveLength(1);
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    "two concurrent createUser() with DIFFERENT usernames both succeed",
    async () => {
      const [a, b] = await Promise.all([
        createUser({ username: "alice", password: "longenoughpw" }),
        createUser({ username: "bob", password: "longenoughpw" }),
      ]);
      expect(a.username).toBe("alice");
      expect(b.username).toBe("bob");
      expect(a.id).not.toBe(b.id);
    },
    STRESS_TIMEOUT_MS,
  );

  it("second createUser() after first completes throws UsernameConflictError", async () => {
    await createUser({ username: "carol", password: "longenoughpw" });
    await expect(
      createUser({ username: "carol", password: "different" }),
    ).rejects.toBeInstanceOf(UsernameConflictError);
  });

  it("the unique username conflict is reported via UsernameConflictError, not generic Error", async () => {
    await createUser({ username: "dave", password: "longenoughpw" });
    let captured: unknown;
    try {
      await createUser({ username: "dave", password: "different" });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UsernameConflictError);
    expect((captured as UsernameConflictError).username).toBe("dave");
  });
});
