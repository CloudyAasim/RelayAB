/**
 * tests/unit/usage-includes-assistant-credential.test.ts
 *
 * 「用我的账号身份」 made the assistant spend the user's own pool, and the usage
 * page did not show it.
 *
 * The cause was a shared list answering two different questions. The assistant
 * credential is deliberately absent from `listApiKeysByUser` — correctly, since
 * the user must not be shown a key they cannot use, and it must not eat their
 * `maxActiveKeys` budget. But the usage report was assembled from that same
 * list, so every call the assistant made was charged by `settleUsage` and then
 * excluded from the one page the person affected would look at. The balance
 * went down and the ledger said nothing had happened.
 *
 * An admin never saw the gap, because `listAllApiKeys` does not filter. Two
 * views of one set of transactions, disagreeing.
 *
 * So: the exclusion stays, and the report asks a different question —
 * `listApiKeyIdsForUsage`, which is every key the balance can move through.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { createApiKey, listApiKeysByUser, listApiKeyIdsForUsage } from "@/lib/db/keys";
import { ASSISTANT_KEY_LABEL, createAssistantCredential, setAssistantCredentialEnabled } from "@/lib/db/assistant-keys";
import { recordUsage, __resetBucketPreparationForTest } from "@/lib/db/usage";
import { loadUsageReport } from "@/lib/usage/load";
import { resolveRange } from "@/lib/usage/report";

const ROOT = process.cwd();
const USER_USAGE_ROUTE = join(ROOT, "src/app/api/user/usage/route.ts");
const USER_USAGE_PAGE = join(ROOT, "src/app/(user)/dashboard/usage/page.tsx");
const USER_USAGE_TOOL = join(ROOT, "src/lib/assistant/tools.ts");

const OWN_CREDITS = 3;
const ASSISTANT_CREDITS = 7;

function usage(over: { apiKeyId: string; userId: string; creditsUsed: number }) {
  return {
    apiKeyId: over.apiKeyId,
    userId: over.userId,
    providerId: "prov",
    model: "m-a",
    upstreamModel: "m-a",
    promptTokens: 100,
    completionTokens: 20,
    creditsUsed: over.creditsUsed,
    status: "success" as const,
  };
}

describe("a user's own usage report covers what the assistant spent for them", () => {
  let userId: string;
  let ownKeyId: string;
  let assistantKeyId: string;

  beforeEach(async () => {
    __resetDbForTest();
    __resetBucketPreparationForTest();
    const user = await createUser({ username: "payer", password: "longenoughpw" });
    userId = user.id;

    const { key: own } = await createApiKey({ userId, label: "laptop" });
    ownKeyId = own.id;

    const credential = await createAssistantCredential(userId);
    assistantKeyId = credential.apiKeyId;
    // On, because a switched-off credential is the case where nobody would
    // expect to be charged at all. This test is about the one that is.
    await setAssistantCredentialEnabled(userId, true);

    await recordUsage(usage({ apiKeyId: ownKeyId, userId, creditsUsed: OWN_CREDITS }));
    await recordUsage(
      usage({ apiKeyId: assistantKeyId, userId, creditsUsed: ASSISTANT_CREDITS }),
    );
  });

  it("the credential stays out of the list of keys the user can use", async () => {
    const { keys } = await listApiKeysByUser(userId, { limit: 200 });
    expect(keys.map((k) => k.id)).toEqual([ownKeyId]);
    expect(keys.map((k) => k.label)).not.toContain(ASSISTANT_KEY_LABEL);
  });

  it("but is inside the set of keys the balance can be charged through", async () => {
    expect(await listApiKeyIdsForUsage(userId)).toEqual(
      expect.arrayContaining([ownKeyId, assistantKeyId]),
    );
  });

  it("so the report totals both, and names the assistant key as a spender", async () => {
    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const report = await loadUsageReport({
      keyIds: await listApiKeyIdsForUsage(userId),
      tzOffsetMinutes: 480,
      range,
    });

    expect(report.summary.requests).toBe(2);
    expect(report.summary.creditsUsed).toBe(OWN_CREDITS + ASSISTANT_CREDITS);
    // A row the user can see and understand, not a silent addition to a total.
    expect(report.byKey.map((row) => row.id)).toContain(assistantKeyId);
  });

  it("and the old list is what used to hide it — pinned so the gap stays visible", async () => {
    const { keys } = await listApiKeysByUser(userId, { limit: 200 });
    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const report = await loadUsageReport({
      keyIds: keys.map((k) => k.id),
      tzOffsetMinutes: 480,
      range,
    });

    // Charged, and absent. This is the bug; it is asserted so that anyone
    // tempted to "simplify" the two lists back into one sees why they differ.
    expect(report.summary.creditsUsed).toBe(OWN_CREDITS);
  });

  it("nobody else's keys are pulled in", async () => {
    const other = await createUser({ username: "stranger", password: "longenoughpw" });
    const { key } = await createApiKey({ userId: other.id, label: "theirs" });
    expect(await listApiKeyIdsForUsage(userId)).not.toContain(key.id);
  });
});

describe("both user-facing entry points ask the right question", () => {
  it("the usage API reports over every chargeable key", () => {
    const src = readFileSync(USER_USAGE_ROUTE, "utf8");
    expect(src).toMatch(/await listApiKeyIdsForUsage\(me\.id\)/);
    // Anchored to the call, not the bare name: a comment explaining why the
    // management list is the wrong one here is allowed, and must be.
    expect(src).not.toMatch(/listApiKeysByUser\(me\.id\)/);
  });

  it("the page separates the picker from the report", () => {
    const src = readFileSync(USER_USAGE_PAGE, "utf8");
    // The picker still offers only usable keys…
    expect(src).toMatch(/listApiKeysByUser\(sessionUser\.id/);
    // …while the report's universe is the chargeable set, not `keys.map(...)`.
    expect(src).toMatch(/listApiKeyIdsForUsage\(sessionUser\.id\)/);
    expect(src).toMatch(/const universeIds = usageKeyIds;/);
    expect(src).not.toMatch(/const universeIds = keys\.map/);
  });

  it("the assistant's own usage tool does not contradict itself", () => {
    const src = readFileSync(USER_USAGE_TOOL, "utf8");
    // Key *counts* stay on the management list: the assistant credential is not
    // one of the user's keys, and counting it would overstate their usage of
    // `maxActiveKeys`.
    expect(src).toMatch(/const \{ keys \} = await listApiKeysByUser\(ctx\.user\.id/);
    // *Spending* comes from the chargeable set. Reading it from the same list
    // put a `quotaUsed` that included the assistant's calls directly above a
    // breakdown that did not.
    expect(src).toMatch(/const chargeableIds = await listApiKeyIdsForUsage\(ctx\.user\.id\)/);
    expect(src).toMatch(/aggregateByKeyMany\(chargeableIds\)/);
    expect(src).toMatch(/listRecentUsage\(chargeableIds/);
    expect(src).not.toMatch(/aggregateByKeyMany\(keys\.map/);
  });
});
