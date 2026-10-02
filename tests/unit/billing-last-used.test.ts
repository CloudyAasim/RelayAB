/**
 * tests/unit/billing-last-used.test.ts
 *
 * `lastUsedAt` was only touched when credits were actually deducted, so on a
 * deployment where no model is priced — `0` means *not priced*, not *free* —
 * it stayed null forever. Observed live on a key that had served 121
 * requests: the admin key list showed it as never used.
 *
 * That is not cosmetic. "Has this key ever been used?" is what an operator
 * looks at before deciding a key is dead and safe to delete, and the answer
 * was wrong on exactly the deployments least likely to have prices set.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey, listApiKeysByUser } from "@/lib/db/keys";
import { listUsageByKey } from "@/lib/db/usage";
import { createProvider, getProviderById } from "@/lib/db/providers";
import { settleUsage } from "@/lib/proxy/billing";
import { settleMediaUsage } from "@/lib/media/billing";
import type { ApiKey, User } from "@/lib/db/types";

let user: User;
let key: ApiKey;
let providerId: string;

beforeEach(async () => {
  __resetDbForTest();
  user = (await createUser({
    username: "billed",
    password: "correct horse battery",
    displayName: "billed",
    role: "user",
  }))!;
  const created = await createApiKey({ userId: user.id, label: "k" });
  key = created.key;
  // No inputCost/outputCost: an unpriced model, which is what a fresh install
  // looks like and what every model on this deployment looks like.
  providerId = (
    await createProvider({
      name: "P",
      kind: "openai",
      apiKey: "sk-upstream",
      modelMapping: { m: "m" },
      modelConfigs: {
        m: { upstreamId: "m", clientId: "m", contextLength: 128_000, maxOutputTokens: 4096 },
      },
      enabled: true,
    })
  )!.id;
});

async function lastUsed(): Promise<string | null> {
  const { keys } = await listApiKeysByUser(user.id, { limit: 10 });
  return keys[0]?.lastUsedAt ?? null;
}

async function settleChat() {
  const provider = (await getProviderById(providerId))!;
  await settleUsage({
    provider,
    apiKey: key,
    user,
    model: "m",
    upstreamModel: "m",
    promptTokens: 100,
    completionTokens: 50,
    billingMode: "usage",
  });
}

describe("lastUsedAt records usage, not billing", () => {
  it("is stamped for an unpriced chat model", async () => {
    expect(await lastUsed()).toBeNull();
    await settleChat();
    expect(await lastUsed()).not.toBeNull();
  });

  it("is stamped for an unpriced media call", async () => {
    await settleMediaUsage({
      apiKey: key,
      user,
      providerId,
      model: "image-01",
      upstreamModel: "image-01",
      capability: "image.generate" as never,
      images: 1,
      creditsUsed: 0,
    });
    expect(await lastUsed()).not.toBeNull();
  });

  it("still records the usage row and charges nothing", async () => {
    await settleChat();

    const rows = await listUsageByKey(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].creditsUsed).toBe(0);
    expect(rows[0].totalTokens).toBe(150);

    // The pool must be untouched: unpriced is not free-to-charge.
    const after = await getUserById(user.id);
    expect(after?.quotaUsed).toBe(0);
  });
});
