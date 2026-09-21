/**
 * tests/integration/bootstrap-no-throw.test.ts
 *
 * Regression test for the "Bootstrap failed; Username already exists" log.
 *
 * Before the fix:
 *   - bootstrapAdmin() re-threw UsernameConflictError when SETNX on
 *     meta:initialized failed and another concurrent bootstrap had
 *     already created the admin.
 *   - ensureBootstrapped() logged "[relayab] Bootstrap failed; the next
 *     request will retry: ..." and re-threw.
 *   - The page handler crashed and the user saw a 500.
 *
 * After the fix:
 *   - bootstrapAdmin() catches UsernameConflictError and returns a
 *     "no-op created" result. No throw.
 *   - ensureBootstrapped() ALSO catches UsernameConflictError defensively,
 *     so any future code path that adds a second createUser call won't
 *     reintroduce the same bug.
 *   - The user sees a normal login page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  ensureBootstrapped,
  __resetBootstrapForTest,
  runBootstrap,
} from "@/lib/db/bootstrap";
import { listUsers } from "@/lib/db/users";

const STRESS_TIMEOUT_MS = 30_000;

describe("bootstrap never throws on UsernameConflictError", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
    __resetBootstrapForTest();
  });

  it("a second runBootstrap (after the admin exists) does NOT throw UsernameConflictError", async () => {
    // First call creates the admin.
    const first = await runBootstrap();
    expect(first.adminCreated).toBe(true);

    // Second call: admin already exists, so the SETNX lock in
    // bootstrapAdmin fails, and bootstrapAdmin would have re-thrown
    // UsernameConflictError pre-fix. After the fix, the catch swallows
    // it as a no-op.
    const second = await runBootstrap();
    expect(second.adminCreated).toBe(false);

    // Exactly one admin was created.
    const { users } = await listUsers({ limit: 100 });
    expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
  });

  it(
    "runBootstrap never throws UsernameConflictError under concurrent invocation",
    async () => {
      // Fire many concurrent bootstrap calls. None should reject.
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => runBootstrap()),
      );
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);

      const { users } = await listUsers({ limit: 100 });
      expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    "ensureBootstrapped resolves even if called from many 'first requests' simultaneously",
    async () => {
      // Simulate 20 simultaneous cold-starts hitting the same Lambda.
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => ensureBootstrapped()),
      );
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);

      const { users } = await listUsers({ limit: 100 });
      expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
    },
    STRESS_TIMEOUT_MS,
  );

  it(
    "bootstrap is idempotent: 10 sequential calls produce exactly one admin",
    async () => {
      for (let i = 0; i < 10; i++) {
        await runBootstrap();
      }
      const { users } = await listUsers({ limit: 200 });
      expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
    },
    STRESS_TIMEOUT_MS,
  );

  it("ensureBootstrapped's catch handler turns UsernameConflictError into a no-op result", async () => {
    // Force a UsernameConflictError out of runBootstrap by pre-creating
    // a user named "admin" with role=user. bootstrapAdmin's polling will
    // see the existing user and short-circuit — but let's make sure the
    // defensive catch in ensureBootstrapped also works.
    const { createUser } = await import("@/lib/db/users");
    await createUser({
      username: "admin",
      password: "differentpassword",
      role: "user",
    });

    // This should NOT throw.
    const result = await ensureBootstrapped();
    expect(result).toBeDefined();
    expect(result.adminCreated).toBe(false);
  });
});
