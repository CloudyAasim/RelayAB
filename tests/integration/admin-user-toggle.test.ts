/**
 * Integration test for the admin user toggle endpoint.
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
  disableUser,
} from "@/lib/db/users";

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis());
});

describe("updateUser with disabled flag", () => {
  it("disabled: false → true persists to Redis hash", async () => {
    const u = await createUser({ username: "alice", password: "pw" });
    expect(u.disabled).toBe(false);

    const updated = await updateUser(u.id, { disabled: true });
    expect(updated?.disabled).toBe(true);

    const reloaded = await getUserById(u.id);
    expect(reloaded?.disabled).toBe(true);
  });

  it("disabled: true → false (using disableUser then updateUser)", async () => {
    const u = await createUser({ username: "bob", password: "pw" });
    await disableUser(u.id);
    expect((await getUserById(u.id))?.disabled).toBe(true);

    const updated = await updateUser(u.id, { disabled: false });
    expect(updated?.disabled).toBe(false);

    const reloaded = await getUserById(u.id);
    expect(reloaded?.disabled).toBe(false);
  });

  it("multiple toggles all persist correctly", async () => {
    const u = await createUser({ username: "carol", password: "pw" });

    await updateUser(u.id, { disabled: true });
    expect((await getUserById(u.id))?.disabled).toBe(true);

    await updateUser(u.id, { disabled: false });
    expect((await getUserById(u.id))?.disabled).toBe(false);

    await updateUser(u.id, { disabled: true });
    expect((await getUserById(u.id))?.disabled).toBe(true);
  });

  it("raw Redis hash stores '1' / '0' correctly", async () => {
    const { getRedis, k } = await import("@/lib/db/redis");
    const u = await createUser({ username: "dave", password: "pw" });

    await updateUser(u.id, { disabled: true });
    const raw = await getRedis().hgetall<Record<string, string>>(k.user(u.id));
    expect(raw?.disabled).toBe("1");

    await updateUser(u.id, { disabled: false });
    const raw2 = await getRedis().hgetall<Record<string, string>>(k.user(u.id));
    expect(raw2?.disabled).toBe("0");
  });
});
