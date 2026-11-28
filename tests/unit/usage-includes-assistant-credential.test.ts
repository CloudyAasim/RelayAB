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

import { __resetDbForTest, run } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import {
  createApiKey,
  deleteApiKey,
  listAllApiKeyIdsForUsage,
  listAllApiKeys,
  listApiKeysByUser,
  listApiKeyIdsForUsage,
} from "@/lib/db/keys";
import { ASSISTANT_KEY_LABEL, createAssistantCredential, setAssistantCredentialEnabled } from "@/lib/db/assistant-keys";
import { recordUsage, __resetBucketPreparationForTest } from "@/lib/db/usage";
import { loadUsageReport, sumAllTime } from "@/lib/usage/load";
import { resolveRange } from "@/lib/usage/report";

const ROOT = process.cwd();
const USER_USAGE_ROUTE = join(ROOT, "src/app/api/user/usage/route.ts");
const USER_USAGE_PAGE = join(ROOT, "src/app/(user)/dashboard/page.tsx");
const USER_USAGE_TOOL = join(ROOT, "src/lib/assistant/tools.ts");
const ADMIN_USAGE_PAGE = join(ROOT, "src/app/(admin)/admin/usage/page.tsx");
const ADMIN_USAGE_ROUTE = join(ROOT, "src/app/api/admin/usage/route.ts");
const ADMIN_OVERVIEW_PAGE = join(ROOT, "src/app/(admin)/admin/page.tsx");

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

  it("an id listed by both sources is summed once, not twice", async () => {
    // Both the `api_keys` arm and the `usage_buckets` arm can produce the same
    // id for a key that still exists, so the union — not a concatenation — is
    // what keeps the total from doubling.
    const ids = await listApiKeyIdsForUsage(userId);
    expect(new Set(ids).size).toBe(ids.length);

    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const report = await loadUsageReport({ keyIds: ids, tzOffsetMinutes: 480, range });
    expect(report.summary.creditsUsed).toBe(OWN_CREDITS + ASSISTANT_CREDITS);
    expect(report.byKey.filter((row) => row.id === ownKeyId)).toHaveLength(1);
  });

  it("a key deleted after it was charged keeps its history in the report", async () => {
    // Rotating a credential deletes its `api_keys` row, and deleting a key
    // deletes its own. The ledger is never cascaded — the spending already
    // happened — so a set read only from `api_keys` would drop exactly the
    // history the page exists to explain.
    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const before = await loadUsageReport({
      keyIds: await listApiKeyIdsForUsage(userId),
      tzOffsetMinutes: 480,
      range,
    });

    await deleteApiKey(ownKeyId);

    expect((await listApiKeysByUser(userId, { limit: 200 })).keys).toHaveLength(0);
    expect(await listApiKeyIdsForUsage(userId)).toContain(ownKeyId);

    const after = await loadUsageReport({
      keyIds: await listApiKeyIdsForUsage(userId),
      tzOffsetMinutes: 480,
      range,
    });
    expect(after.summary.requests).toBe(before.summary.requests);
    expect(after.summary.creditsUsed).toBe(before.summary.creditsUsed);
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
    // The picker still offers only usable keys… (read through the request-scoped
    // cache, hence the prefix, which this pattern tolerates on purpose).
    expect(src).toMatch(/ListApiKeysByUser\(sessionUser\.id/);
    // …while the report's universe is the chargeable set, not `keys.map(...)`.
    expect(src).toMatch(/listApiKeyIdsForUsage\(sessionUser\.id\)/);
    expect(src).toMatch(/const universeIds = usageKeyIds;/);
    expect(src).not.toMatch(/const universeIds = keys\.map/);
    // The lifetime tiles at the top of the same page read the same universe; a
    // `keys.map` there reported less spending than the balance beside it.
    expect(src).toMatch(/cachedAggregateByUser\(usageKeyIds\)/);
    expect(src).not.toMatch(/cachedAggregateByUser\(keys\.map/);
    // Every row gets a name: the assistant credential through its label, and a
    // deleted key through translated copy instead of its uuid.
    expect(src).toMatch(/assistantKeyLabel\(ASSISTANT_KEY_LABEL, t\)/);
    expect(src).toMatch(/t\("usage\.table\.removedKey"\)/);
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

describe("the deployment-wide universe keeps the same history", () => {
  let payerId: string;
  let liveKeyId: string;
  let deletedKeyId: string;
  let strangerId: string;
  let strangerKeyId: string;

  const STRANGER_CREDITS = 5;

  beforeEach(async () => {
    __resetDbForTest();
    __resetBucketPreparationForTest();

    const payer = await createUser({ username: "payer-b", password: "longenoughpw" });
    payerId = payer.id;
    const { key: live } = await createApiKey({ userId: payerId, label: "live" });
    liveKeyId = live.id;
    const { key: doomed } = await createApiKey({ userId: payerId, label: "doomed" });
    deletedKeyId = doomed.id;

    const stranger = await createUser({ username: "stranger-b", password: "longenoughpw" });
    strangerId = stranger.id;
    const { key: theirs } = await createApiKey({ userId: strangerId, label: "theirs" });
    strangerKeyId = theirs.id;

    await recordUsage(usage({ apiKeyId: liveKeyId, userId: payerId, creditsUsed: OWN_CREDITS }));
    await recordUsage(
      usage({ apiKeyId: deletedKeyId, userId: payerId, creditsUsed: ASSISTANT_CREDITS }),
    );
    await recordUsage(
      usage({ apiKeyId: strangerKeyId, userId: strangerId, creditsUsed: STRANGER_CREDITS }),
    );

    // The spending happened; the `api_keys` row did not survive it.
    await deleteApiKey(deletedKeyId);
  });

  it("an id deleted from `api_keys` is still in the universe", async () => {
    expect(await listAllApiKeyIdsForUsage()).toContain(deletedKeyId);
    // The contrast that made the admin totals wrong: the management list no
    // longer knows the id exists.
    expect((await listAllApiKeys()).map((key) => key.id)).not.toContain(deletedKeyId);
  });

  it("so the report still totals what the deleted key spent", async () => {
    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const report = await loadUsageReport({
      keyIds: await listAllApiKeyIdsForUsage(),
      tzOffsetMinutes: 480,
      range,
    });

    expect(report.summary.requests).toBe(3);
    expect(report.summary.creditsUsed).toBe(
      OWN_CREDITS + ASSISTANT_CREDITS + STRANGER_CREDITS,
    );
    expect(report.byKey.map((row) => row.id)).toContain(deletedKeyId);
  });

  it("an id present in both arms is summed once", async () => {
    // `api_keys` and `usage_buckets` both name every live key, so the union —
    // not a concatenation — is what keeps the deployment total from doubling.
    const ids = await listAllApiKeyIdsForUsage();
    expect(new Set(ids).size).toBe(ids.length);

    const range = resolveRange({ key: "all", tzOffsetMinutes: 480 });
    const report = await loadUsageReport({ keyIds: ids, tzOffsetMinutes: 480, range });
    expect(report.summary.creditsUsed).toBe(
      OWN_CREDITS + ASSISTANT_CREDITS + STRANGER_CREDITS,
    );
    expect(report.byKey.filter((row) => row.id === liveKeyId)).toHaveLength(1);
  });

  it("filtering to one user answers exactly what that user's page answers", async () => {
    expect(await listAllApiKeyIdsForUsage({ userId: payerId })).toEqual(
      await listApiKeyIdsForUsage(payerId),
    );
    // …and that set still reaches the deleted key, while leaving the stranger out.
    const ids = await listAllApiKeyIdsForUsage({ userId: payerId });
    expect(ids).toContain(deletedKeyId);
    expect(ids).not.toContain(strangerKeyId);
  });
});

describe("the universe also reaches a key that only has a lifetime counter", () => {
  it("an id whose rows and buckets are both gone still counts", async () => {
    __resetDbForTest();
    __resetBucketPreparationForTest();
    const payer = await createUser({ username: "payer-c", password: "longenoughpw" });
    const { key } = await createApiKey({ userId: payer.id, label: "gone" });
    await recordUsage(usage({ apiKeyId: key.id, userId: payer.id, creditsUsed: 4 }));

    // A deployment that ran the old rebuild on a pruned log window: the rows
    // are gone, the bucket was deleted with them, and so was the key itself.
    // The lifetime counter is the only thing left that knows money moved.
    run("DELETE FROM usage_logs WHERE api_key_id = ?", [key.id]);
    run("DELETE FROM usage_buckets WHERE api_key_id = ?", [key.id]);
    await deleteApiKey(key.id);

    const ids = await listAllApiKeyIdsForUsage();
    expect(ids).toEqual([key.id]);
    expect(await sumAllTime(ids)).toMatchObject({ requests: 1, creditsUsed: 4 });

    // The "all" total comes from the counter, so the money is still in the
    // figure at the top of the page. No time dimension survives it, so the
    // breakdown cannot show it — which is exactly why the report has to say
    // which path produced the figures instead of leaving a blank chart to be
    // read as "nothing happened".
    const report = await loadUsageReport({
      keyIds: ids,
      tzOffsetMinutes: 480,
      range: resolveRange({ key: "all", tzOffsetMinutes: 480 }),
    });
    expect(report.summary.creditsUsed).toBe(4);
    expect(report.byKey).toHaveLength(0);
    expect(report.source).toBe("retained-logs");
  });
});

describe("the admin entry points read the same universe", () => {
  it("the usage page reports over every id spending touched", () => {
    const src = readFileSync(ADMIN_USAGE_PAGE, "utf8");
    expect(src).toMatch(/listAllApiKeyIdsForUsage\(\)/);
    // `allKeys` still feeds the scope picker — a deleted key has no label and
    // nothing to revoke — but it is no longer the report's universe.
    expect(src).toMatch(/universeIds/);
    expect(src).not.toMatch(/const universeIds = allKeys\.map/);
  });

  it("the admin usage API filters the universe by user, not by the key list", () => {
    const src = readFileSync(ADMIN_USAGE_ROUTE, "utf8");
    expect(src).toMatch(/listAllApiKeyIdsForUsage\(\{ userId \}\)/);
    expect(src).not.toMatch(/keyIds: keys\.map/);
  });

  it("the overview totals and recent requests cover the same set", () => {
    const src = readFileSync(ADMIN_OVERVIEW_PAGE, "utf8");
    expect(src).toMatch(/aggregateByKeyMany\(usageKeyIds\)/);
    expect(src).toMatch(/listRecentUsage\(usageKeyIds/);
    expect(src).not.toMatch(/aggregateByKeyMany\(keys\.map/);
    expect(src).not.toMatch(/listRecentUsage\(keys\.map/);
  });
});
