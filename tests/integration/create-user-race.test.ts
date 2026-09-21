/**
 * tests/integration/create-user-race.test.ts
 *
 * Stress-test for the createUser() race.
 *
 * Before the fix, createUser() did a GET-then-SET on the by-username
 * secondary index, leaving a TOCTOU window where two concurrent calls
 * could both observe "username not taken" and both write successfully.
 *
 * After the fix, createUser() uses SETNX on the by-username index for
 * atomic reservation. The losing caller gets UsernameConflictError.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  createUser,
  getUserByUsername,
  listUsers,
  UsernameConflictError,
} from "@/lib/db/users";

// bcrypt at work factor 12 is ~200ms per call. Stress tests need headroom
// over the vitest default of 5s.
const STRESS_TIMEOUT_MS = 30_000;

describe("createUser race protection", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
  });

  it(
    "20 concurrent createUser('admin') → exactly one succeeds",
    async () => {
      const attempts = Array.from({ length: 20 }, () =>
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
      expect(conflicts).toHaveLength(19);

      // Exactly one user record exists in Redis.
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
