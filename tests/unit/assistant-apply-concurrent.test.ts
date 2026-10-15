/**
 * tests/unit/assistant-apply-concurrent.test.ts
 *
 * Two approvals in flight at once, against the real endpoint.
 *
 * The previous test for this reimplemented the apply logic in-process and ran
 * the two approvals *sequentially* — which is the case that had already been
 * fixed, so it went on passing while the overlapping case stayed broken. It
 * could not have caught it: reproducing a lost update needs the two reads to
 * interleave, and a function that reads then writes, called one after the
 * other, never interleaves anything. This one calls `POST` twice without
 * awaiting in between, so both requests are inside `getProviderById` before
 * either has written.
 *
 * What that shape produces, with the read outside the write's transaction:
 *
 *   A  read provider → { m1: old, m2: old }
 *   B  read provider → { m1: old, m2: old }     ← same snapshot
 *   A  merge its own change into that → write
 *   B  merge *its* change into the same snapshot → write   ← A's change is gone
 *
 * Both rows then read `applied`, which is the part that made the original
 * incident hard to see: the queue agreed with itself and disagreed with the
 * database.
 *
 * Both calls go through the real route, the real session guard, the real
 * database layer, and the real `withTransaction` — so what is asserted is the
 * behaviour of the shipped code rather than of a copy of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { POST } from "@/app/api/assistant/actions/[id]/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider, getProviderById } from "@/lib/db/providers";
import { createAssistantAction } from "@/lib/db/assistant";
import { createUser } from "@/lib/db/users";
import type { Provider, User } from "@/lib/db/types";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { ModelConfigMergePatchSchema } from "@/lib/db/types";

const ENDPOINT = "https://api.example/api/assistant/actions/x";

function approve(id: string): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
}

describe("two approvals of the same provider, at the same time", () => {
  let store: InMemoryCookieStore;
  let admin: User;
  let provider: Provider;

  beforeEach(async () => {
    __resetDbForTest();
    store = new InMemoryCookieStore();
    currentStore = store;
    admin = (await createUser({
      username: "apply-admin",
      password: "correct horse battery",
      displayName: "apply-admin",
      role: "admin",
    }))!;
    const session = await getSessionFromStore(store);
    session.userId = admin.id;
    session.username = admin.username;
    session.role = "admin";
    await session.save();

    provider = await createProvider({
      name: "Concurrent Co",
      kind: "openai",
      baseUrl: "https://api.example/v1",
      upstreamFormat: "chat",
      apiKey: "sk-test",
      modelMapping: { "m1": "up-1", "m2": "up-2" },
      modelConfigs: {
        m1: {
          upstreamId: "up-1",
          clientId: "m1",
          displayName: "m1",
          contextLength: 128000,
          maxOutputTokens: 4096,
          inputCost: 100,
          outputCost: 200,
          enabled: true,
        },
        m2: {
          upstreamId: "up-2",
          clientId: "m2",
          displayName: "m2",
          contextLength: 128000,
          maxOutputTokens: 4096,
          inputCost: 100,
          outputCost: 200,
          enabled: true,
        },
      },
    });
  });

  afterEach(() => {
    currentStore = null;
    __resetDbForTest();
  });

  /** A proposal that changes one model's price, in the shape the tools write. */
  async function priceProposal(clientId: string, inputCost: number): Promise<string> {
    const action = await createAssistantAction({
      userId: admin.id,
      kind: "provider.update",
      targetId: provider.id,
      summary: `调整 ${clientId} 的输入价`,
      args: {
        modelConfigTargets: [
          {
            clientId,
            patch: ModelConfigMergePatchSchema.parse({ inputCost, outputCost: 200 }),
          },
        ],
      },
      diff: "价格变更",
    });
    return action.id;
  }

  it("keeps both changes", async () => {
    const [a, b] = await Promise.all([
      priceProposal("m1", 111),
      priceProposal("m2", 222),
    ]);

    // Both requests are issued before either is awaited, so both are inside
    // their read when the first write lands.
    const [ra, rb] = await Promise.all([
      POST(approve(a), { params: Promise.resolve({ id: a }) }),
      POST(approve(b), { params: Promise.resolve({ id: b }) }),
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);

    const after = await getProviderById(provider.id);
    expect(
      after?.modelConfigs?.m1?.inputCost,
      "the first approval's change was overwritten by the second",
    ).toBe(111);
    expect(
      after?.modelConfigs?.m2?.inputCost,
      "the second approval's change did not land",
    ).toBe(222);
  });

  it("and the table keeps the models neither proposal mentioned", async () => {
    const [a, b] = await Promise.all([
      priceProposal("m1", 111),
      priceProposal("m2", 222),
    ]);
    await Promise.all([
      POST(approve(a), { params: Promise.resolve({ id: a }) }),
      POST(approve(b), { params: Promise.resolve({ id: b }) }),
    ]);

    const after = await getProviderById(provider.id);
    expect(Object.keys(after?.modelConfigs ?? {}).sort()).toEqual(["m1", "m2"]);
    // Fields neither proposal wrote, read out of both merges.
    expect(after?.modelConfigs?.m1?.contextLength).toBe(128000);
    expect(after?.modelConfigs?.m2?.outputCost).toBe(200);
  });

  it("a rejected proposal does not undo one that was applied", async () => {
    const [applied, rejected] = await Promise.all([
      priceProposal("m1", 111),
      priceProposal("m2", 222),
    ]);

    const rejectRequest = (id: string): Request =>
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      });

    await Promise.all([
      POST(approve(applied), { params: Promise.resolve({ id: applied }) }),
      POST(rejectRequest(rejected), { params: Promise.resolve({ id: rejected }) }),
    ]);

    const after = await getProviderById(provider.id);
    // Whatever order they landed in, m1 was approved and m2 was not. The bug
    // this guards was the queue saying "rejected" over a change that had in
    // fact been written.
    expect(after?.modelConfigs?.m1?.inputCost).toBe(111);
    expect(after?.modelConfigs?.m2?.inputCost).toBe(100);
  });
});
