/**
 * tests/unit/assistant-search-service-settings.test.ts
 *
 * The search service in the assistant's settings.
 *
 * It arrived as two boxes and a rule ("fill the address in and it is used"),
 * and both halves were answers nobody could read off the page: which of the two
 * was live, and what a search through it would cost. Six things were wrong with
 * that, and this file holds up the fixes:
 *
 *  1. **Which one is live** is now an explicit choice. "The address box is
 *     filled in" is not a state a person can see, and a stored address with the
 *     deployment's provider in use looks exactly like the opposite.
 *  2. **A mistyped address is refused when it is saved**, not on the first
 *     search — which is where the error would be phrased as the vendor's.
 *  3. **"My own service" without an address is refused**, rather than quietly
 *     searching through the deployment's provider instead.
 *  4. **The key can be deleted.** A blank password box cannot say "delete it" —
 *     it can only say "I did not type one".
 *  5. **The probe tells three answers apart**: reachable with hits, reachable
 *     with nothing, and reachable but answered with something that is not a
 *     search result. The last one looks exactly like the second one.
 *  6. **A failing search of the user's own service says so**, and says where
 *     the switch is — the deployment's providers are still fine, and the model
 *     would otherwise send the user to look at the wrong thing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { useOwnSearchService } from "@/lib/search/user";
import { readSearchItems, executeSearchWithReport } from "@/lib/search/engine";
import { OPENAI_COMPATIBLE_TEMPLATE } from "@/lib/search/templates";
import { PUT as PUT_SETTINGS } from "@/app/api/assistant/settings/route";
import { POST as PROBE_SEARCH } from "@/app/api/assistant/search-settings/route";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import { getAssistantSettings, saveAssistantSettings } from "@/lib/db/assistant";
import { getSessionFromStore, InMemoryCookieStore } from "@/lib/auth/session";
import type { User } from "@/lib/db/types";

let user: User;

async function signIn(): Promise<void> {
  const store = new InMemoryCookieStore();
  const session = await getSessionFromStore(store);
  session.userId = user.id;
  session.username = user.username;
  session.role = "user";
  await session.save();
  currentStore = store;
}

function settingsRequest(body: unknown): Request {
  return new Request("https://relay.test/api/assistant/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  __resetDbForTest();
  currentStore = null;
  user = (await createUser({
    username: "search-service",
    password: "correct horse battery",
    displayName: "search-service",
    quotaLimit: 100_000,
  }))!;
});

describe("which backend the assistant searches with", () => {
  it("is the user's own when the source says so", () => {
    expect(
      useOwnSearchService({ searchSource: "own", searchBaseUrl: "https://x.test/search" }),
    ).toBe(true);
  });

  it("is the deployment's when the source says so — even with an address stored", () => {
    // The case the feature had no answer for: the user's own service is down
    // for a while, and the address they typed should not have to be thrown
    // away for the assistant to keep searching.
    expect(
      useOwnSearchService({ searchSource: "deployment", searchBaseUrl: "https://x.test/search" }),
    ).toBe(false);
  });

  it("and, with no choice made, the old rule still holds", () => {
    // Every row written before the choice existed is in this state, and it must
    // keep working exactly as it did: own service when there is an address.
    expect(useOwnSearchService({ searchSource: null, searchBaseUrl: "https://x.test/search" })).toBe(
      true,
    );
    expect(useOwnSearchService({ searchSource: null, searchBaseUrl: null })).toBe(false);
    expect(useOwnSearchService(null)).toBe(false);
  });

  it("and 'my own' with no address is not the own service either", () => {
    // The second line of defence. The save refuses to create this state, and
    // the runtime does not act on it either: a row that says "own" with no
    // address falls back to the deployment's provider rather than pretending.
    expect(useOwnSearchService({ searchSource: "own", searchBaseUrl: null })).toBe(false);
    expect(useOwnSearchService({ searchSource: "own", searchBaseUrl: "  " })).toBe(false);
  });
});

describe("saving the search service", () => {
  it("refuses an address that is not http(s)", async () => {
    await signIn();
    const res = await PUT_SETTINGS(
      settingsRequest({
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        searchSource: "own",
        searchBaseUrl: "not a url",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("bad_search_url");
    // And nothing was stored.
    expect((await getAssistantSettings(user.id))?.searchBaseUrl).toBeFalsy();
  });

  it("refuses 'my own service' with no address, instead of quietly using the deployment's", async () => {
    await signIn();
    const res = await PUT_SETTINGS(
      settingsRequest({
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        searchSource: "own",
        searchBaseUrl: "",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_search_url");
  });

  it("refuses it too when the address is being cleared while the source says 'own'", async () => {
    // The address checked has to be the one that will be **in effect after the
    // save**. Checking the stored one would let through exactly the state that
    // must not exist: "my own service" with no address, which the assistant
    // would answer with the deployment's provider instead.
    await signIn();
    await PUT_SETTINGS(
      settingsRequest({
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        searchSource: "own",
        searchBaseUrl: "https://my-gateway.test/v1/search",
      }),
    );
    expect((await getAssistantSettings(user.id))?.searchBaseUrl).toBe(
      "https://my-gateway.test/v1/search",
    );

    const res = await PUT_SETTINGS(
      settingsRequest({
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        searchSource: "own",
        searchBaseUrl: null,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("no_search_url");
    // And the stored address is still there — the refused save changed nothing.
    expect((await getAssistantSettings(user.id))?.searchBaseUrl).toBe(
      "https://my-gateway.test/v1/search",
    );
  });

  it("stores the address, the source and the key", async () => {
    await signIn();
    const res = await PUT_SETTINGS(
      settingsRequest({
        baseUrl: "",
        model: "",
        accountModel: "m",
        credentialMode: "account",
        searchSource: "own",
        searchBaseUrl: "https://my-gateway.test/v1/search",
        searchApiKey: "sk-mine",
      }),
    );
    expect(res.status).toBe(200);
    const stored = await getAssistantSettings(user.id);
    expect(stored?.searchBaseUrl).toBe("https://my-gateway.test/v1/search");
    expect(stored?.searchSource).toBe("own");
    // The key is encrypted, never in the clear.
    expect(stored?.encryptedSearchApiKey).toBeTruthy();
    expect(stored?.encryptedSearchApiKey).not.toContain("sk-mine");
  });

  it("deletes the key when it is asked to, and keeps it otherwise", async () => {
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchSource: "own",
      searchBaseUrl: "https://my-gateway.test/v1/search",
      searchApiKey: "sk-mine",
    });
    expect((await getAssistantSettings(user.id))?.encryptedSearchApiKey).toBeTruthy();

    // A blank key keeps it: the box was empty because nothing was typed.
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchApiKey: "",
    });
    expect((await getAssistantSettings(user.id))?.encryptedSearchApiKey).toBeTruthy();

    // `null` is the explicit "delete it" — which a blank box cannot express.
    await saveAssistantSettings(user.id, {
      baseUrl: "",
      model: "",
      accountModel: "m",
      credentialMode: "account",
      searchApiKey: null,
    });
    expect((await getAssistantSettings(user.id))?.encryptedSearchApiKey).toBeNull();
  });
});

describe("probing the search service", () => {
  function probeRequest(): Request {
    return new Request("https://relay.test/api/assistant/search-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://my-gateway.test/v1/search" }),
    });
  }

  it("says the answer was a search result, and how many hits it carried", async () => {
    await signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "search",
          results: [{ title: "A", url: "https://a.test/", snippet: "a" }],
        }),
      ),
    );
    const res = await PROBE_SEARCH(probeRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { shapeOk: boolean; itemCount: number; results: unknown[] };
    };
    expect(body.data.shapeOk).toBe(true);
    expect(body.data.itemCount).toBe(1);
    expect(body.data.results).toHaveLength(1);
  });

  it("says the service answered with something that is not a search result", async () => {
    // The case an empty list cannot report: the endpoint is reachable and
    // answers, but the hits are not where the shape says they are. It looks
    // exactly like "the service works and found nothing" unless the probe
    // says otherwise.
    await signIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ title: "A", url: "https://a.test/" }] })),
    );
    const res = await PROBE_SEARCH(probeRequest());
    const body = (await res.json()) as { data: { shapeOk: boolean; itemCount: number } };
    expect(body.data.shapeOk).toBe(false);
    expect(body.data.itemCount).toBe(0);
  });

  it("and says so when it is reachable and simply found nothing", async () => {
    await signIn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [] })));
    const res = await PROBE_SEARCH(probeRequest());
    const body = (await res.json()) as { data: { shapeOk: boolean; itemCount: number } };
    expect(body.data.shapeOk).toBe(true);
    expect(body.data.itemCount).toBe(0);
  });
});

describe("the engine's own report", () => {
  it("separates 'no hits' from 'not the shape we asked for'", () => {
    const spec = OPENAI_COMPATIBLE_TEMPLATE.spec;
    expect(readSearchItems(spec, { results: [] })).toEqual([]);
    expect(readSearchItems(spec, { data: [] })).toBeNull();
    expect(readSearchItems(spec, "not json at all")).toBeNull();
  });

  it("and reports both facts about one answer", async () => {
    const spec = OPENAI_COMPATIBLE_TEMPLATE.spec;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [{ title: "A", url: "https://a.test/" }] })),
    );
    const report = await executeSearchWithReport(spec, "https://my-gateway.test/v1/search", {
      query: "q",
      limit: 5,
      displayName: "自己的搜索服务",
    });
    expect(report.shapeOk).toBe(true);
    expect(report.itemCount).toBe(1);
    expect(report.results).toHaveLength(1);
  });
});
