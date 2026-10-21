/**
 * tests/unit/assistant-search-credential-gate.test.ts
 *
 * The deployment's search service needs the account identity.
 *
 * The assistant's search used to be the one path that worked **without** the
 * assistant credential: the model calls went through it, the media calls went
 * through it, and the search went around it. So a user who had deliberately
 * switched their credential off could still spend the deployment's search
 * budget through the assistant.
 *
 * The credential is the account's agreement to spend the deployment's
 * resources, and a service that skips it is not respecting the switch. So:
 *
 *  - the **deployment's** providers need the credential created and switched
 *    on (it needs no key of the user's — the system issues it);
 *  - the **user's own** search service needs neither: their key pays their
 *    vendor and the deployment spends nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser, getUserById } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import { listUsageByKey } from "@/lib/db/usage";
import { listApiKeyIdsForUsage } from "@/lib/db/keys";
import { createSearchProvider } from "@/lib/db/search-providers";
import {
  createAssistantCredential,
  setAssistantCredentialEnabled,
} from "@/lib/db/assistant-keys";
import { saveAssistantSettings } from "@/lib/db/assistant";
import { executeTool } from "@/lib/assistant/tools";
import type { User } from "@/lib/db/types";

let user: User;
let keyId: string;
let fetchMock: ReturnType<typeof vi.fn>;

const SEARCH_ENV = ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "SEARXNG_URL"] as const;
let savedEnv: Array<readonly [string, string | undefined]> = [];

function ctx() {
  return {
    user: { id: user.id, username: user.username, role: "user", timezone: "shanghai" },
  } as never;
}

/**
 * Every usage row of an account, whichever of its keys it hangs off.
 *
 * The search's row is attributed to "one of the account's keys" — the
 * repository's choice — so an assertion about one key would be an assertion
 * about a sort order.
 */
async function usageRowsFor(userId: string) {
  const rows = [];
  for (const id of await listApiKeyIdsForUsage(userId)) {
    rows.push(...(await listUsageByKey(id)));
  }
  return rows;
}

beforeEach(async () => {
  __resetDbForTest();
  savedEnv = SEARCH_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of SEARCH_ENV) delete process.env[k];

  user = (await createUser({
    username: "gate",
    password: "correct horse battery",
    displayName: "gate",
    quotaLimit: 100_000,
  }))!;
  const { key } = await createApiKey({ userId: user.id, label: "k" });
  keyId = key.id;

  // The deployment's own provider — the one that costs the deployment money.
  await createSearchProvider({
    name: "Deployment provider",
    kind: "tavily",
    baseUrl: "https://api.tavily.com",
    apiKey: "vendor-key",
    enabled: true,
    priority: 1,
    creditsPerCall: 1,
  });

  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ results: [{ title: "A", url: "https://a.test/", content: "a" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("the deployment's search service", () => {
  it("is refused when the account identity is not switched on", async () => {
    // The credential exists but the user turned it off. That is the state the
    // refusal is about: not "never created", but "switched off".
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, false);

    const result = await executeTool("web_search", JSON.stringify({ query: "q" }), ctx());
    expect(result.ok).toBe(false);
    // It has to say which switch, and where — a message that only said "no"
    // would send the user looking for the wrong one.
    expect(result.content).toMatch(/用我的账号身份/);
    expect(result.content).toMatch(/AI 助手 . 设置/);
    // And nothing was spent: the vendor was never called.
    expect(fetchMock, "the vendor was called for a refused search").not.toHaveBeenCalled();
    expect((await getUserById(user.id))?.quotaUsed).toBe(0);
  });

  it("is refused when no credential was ever created", async () => {
    const result = await executeTool("web_search", JSON.stringify({ query: "q" }), ctx());
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/用我的账号身份/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("works once the credential is created and switched on", async () => {
    // No key of the user's is involved anywhere: the system issues the
    // credential and the user never sees the plaintext.
    await createAssistantCredential(user.id);
    await setAssistantCredentialEnabled(user.id, true);

    const result = await executeTool("web_search", JSON.stringify({ query: "q" }), ctx());
    expect(result.ok, result.content).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    // …and it is charged, because the deployment paid the vendor.
    expect((await getUserById(user.id))?.quotaUsed).toBe(1000);
    // The usage row hangs off one of the account's keys — which one is the
    // repository's business, so the assertion is over all of them.
    expect(await usageRowsFor(user.id)).toHaveLength(1);
  });
});

describe("the user's own search service", () => {
  it("needs no credential at all", async () => {
    // Their key pays their vendor, so the deployment spends nothing and has no
    // business asking for permission to spend nothing.
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchSource: "own",
      // A **literal public address**, not a hostname: a user's own service is
      // held to the public-address rule (the request is made by the gateway),
      // and a hostname would have to resolve for the check to pass. The
      // literal is judged without a lookup, so the test needs no network.
      searchBaseUrl: "https://93.184.216.34/v1/search",
    });

    const result = await executeTool("web_search", JSON.stringify({ query: "q" }), ctx());
    expect(result.ok, result.content).toBe(true);
    // The call went to their own address, and it was not charged.
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://93.184.216.34/v1/search");
    expect((await getUserById(user.id))?.quotaUsed).toBe(0);
    expect(await usageRowsFor(user.id)).toHaveLength(0);
  });
});
