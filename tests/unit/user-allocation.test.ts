/**
 * tests/unit/user-allocation.test.ts
 *
 * Validates the new per-user quota-allocation feature:
 *   - DEFAULT_USER_ALLOCATION defaults are correct.
 *   - createUser / updateUser persist allocation fields.
 *   - hashToUser fills in defaults when fields are absent (back-compat).
 *   - UserSchema strips unknown keys (zod strict-mode is off; extra keys
 *     are allowed but we want to make sure the parsed result still
 *     contains the new fields).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import {
  createUser,
  getUserById,
  updateUser,
} from "@/lib/db/users";
import { DEFAULT_USER_ALLOCATION, UserSchema } from "@/lib/db/types";

describe("per-user allocation", () => {
  beforeEach(() => {
    __setRedisForTest(createMemoryRedis());
    __resetRedisForTest();
    __setRedisForTest(createMemoryRedis());
  });

  it("DEFAULT_USER_ALLOCATION has safe defaults", () => {
    expect(DEFAULT_USER_ALLOCATION.quotaTypePerKey).toBe("credits");
    expect(DEFAULT_USER_ALLOCATION.quotaLimitPerKey).toBeGreaterThan(0);
    expect(DEFAULT_USER_ALLOCATION.maxActiveKeys).toBe(0);
    expect(DEFAULT_USER_ALLOCATION.allowedModels).toEqual([]);
  });

  it("createUser writes default allocation", async () => {
    const u = await createUser({ username: "alice", password: "longenoughpw" });
    expect(u.quotaTypePerKey).toBe(DEFAULT_USER_ALLOCATION.quotaTypePerKey);
    expect(u.quotaLimitPerKey).toBe(DEFAULT_USER_ALLOCATION.quotaLimitPerKey);
    expect(u.maxActiveKeys).toBe(DEFAULT_USER_ALLOCATION.maxActiveKeys);
    expect(u.allowedModels).toEqual([]);
  });

  it("createUser honours explicit allocation", async () => {
    const u = await createUser({
      username: "bob",
      password: "longenoughpw",
      quotaTypePerKey: "tokens",
      quotaLimitPerKey: 100000,
      maxActiveKeys: 3,
      allowedModels: ["gpt-4o-mini", "claude-3-5-sonnet"],
    });
    expect(u.quotaTypePerKey).toBe("tokens");
    expect(u.quotaLimitPerKey).toBe(100000);
    expect(u.maxActiveKeys).toBe(3);
    expect(u.allowedModels).toEqual(["gpt-4o-mini", "claude-3-5-sonnet"]);
  });

  it("updateUser patches allocation fields without losing other state", async () => {
    const u = await createUser({ username: "carol", password: "longenoughpw" });
    const updated = await updateUser(u.id, {
      quotaTypePerKey: "tokens",
      quotaLimitPerKey: 500000,
      maxActiveKeys: 5,
      allowedModels: ["o1"],
    });
    expect(updated).not.toBeNull();
    expect(updated!.quotaTypePerKey).toBe("tokens");
    expect(updated!.quotaLimitPerKey).toBe(500000);
    expect(updated!.maxActiveKeys).toBe(5);
    expect(updated!.allowedModels).toEqual(["o1"]);
    // Role / displayName untouched.
    expect(updated!.role).toBe(u.role);
    expect(updated!.displayName).toBe(u.displayName);
  });

  it("UserSchema fills in allocation defaults when fields are missing", () => {
    const parsed = UserSchema.parse({
      id: "01J",
      username: "legacy",
      passwordHash: "$2a$12$xxx",
      role: "user",
      displayName: "Legacy",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      lastLoginAt: null,
      disabled: false,
    });
    expect(parsed.quotaTypePerKey).toBe("credits");
    expect(parsed.quotaLimitPerKey).toBeGreaterThan(0);
    expect(parsed.maxActiveKeys).toBe(0);
    expect(parsed.allowedModels).toEqual([]);
  });

  it("getUserById round-trips allocation through Redis", async () => {
    const u = await createUser({
      username: "dave",
      password: "longenoughpw",
      quotaTypePerKey: "tokens",
      quotaLimitPerKey: 12345,
      maxActiveKeys: 7,
      allowedModels: ["gpt-4o"],
    });
    const fetched = await getUserById(u.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.quotaTypePerKey).toBe("tokens");
    expect(fetched!.quotaLimitPerKey).toBe(12345);
    expect(fetched!.maxActiveKeys).toBe(7);
    expect(fetched!.allowedModels).toEqual(["gpt-4o"]);
  });
});
