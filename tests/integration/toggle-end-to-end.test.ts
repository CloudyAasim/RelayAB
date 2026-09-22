/**
 * End-to-end test for the toggle endpoint behavior.
 * Simulates exactly what the admin UI does.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRedisForTest,
  __setRedisForTest,
} from "@/lib/db/redis";
import { createMemoryRedis } from "@/lib/db/__mocks__/memory-redis";
import { createUser, updateUser, getUserById, listUsers } from "@/lib/db/users";
import { getRedis, k } from "@/lib/db/redis";

beforeEach(() => {
  __resetRedisForTest();
  __setRedisForTest(createMemoryRedis());
});

describe("End-to-end toggle flow (simulating admin UI)", () => {
  it("user can be toggled and the new state is immediately visible in listUsers", async () => {
    // Step 1: Create a user (like admin clicks "创建用户")
    const u = await createUser({ username: "alice", password: "pw" });
    expect(u.disabled).toBe(false);

    // Step 2: Admin loads /admin/users → listUsers returns the user as enabled
    const listBefore = await listUsers({ limit: 100 });
    const aliceBefore = listBefore.users.find((x) => x.id === u.id);
    expect(aliceBefore?.disabled).toBe(false);

    // Step 3: Admin clicks "停用" → POST /api/admin/users/[id]/toggle { disabled: true }
    // Simulate the route handler's updateUser call
    const updated = await updateUser(u.id, { disabled: true });
    expect(updated?.disabled).toBe(true);

    // Step 4: After "page refresh", listUsers should show the user as disabled
    const listAfter = await listUsers({ limit: 100 });
    const aliceAfter = listAfter.users.find((x) => x.id === u.id);
    expect(aliceAfter?.disabled).toBe(true);

    // Step 5: And the raw Redis hash should show "1"
    const raw = await getRedis().hgetall<Record<string, string>>(k.user(u.id));
    expect(raw?.disabled).toBe("1");
  });

  it("user can be re-enabled after being disabled", async () => {
    const u = await createUser({ username: "bob", password: "pw" });

    // Disable
    await updateUser(u.id, { disabled: true });
    expect((await listUsers({ limit: 100 })).users.find((x) => x.id === u.id)?.disabled).toBe(true);

    // Re-enable
    await updateUser(u.id, { disabled: false });
    expect((await listUsers({ limit: 100 })).users.find((x) => x.id === u.id)?.disabled).toBe(false);

    // Verify raw Redis
    const raw = await getRedis().hgetall<Record<string, string>>(k.user(u.id));
    expect(raw?.disabled).toBe("0");
  });
});
