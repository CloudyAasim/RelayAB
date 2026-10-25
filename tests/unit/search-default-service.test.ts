/**
 * tests/unit/search-default-service.test.ts
 *
 * The default search service: the operator's visible choice.
 *
 * A client that speaks the other search APIs has no field for "which engine" —
 * there is nothing in the request to put it in. So a deployment with more than
 * one search service has to say which one answers **on its own**, or every
 * such request fails with "please name one".
 *
 * The rule this file pins is the whole point of the feature, and it cuts both
 * ways:
 *
 *  - the marked default **answers**, and the answer says which service it was
 *    (`service` in the response, the "default" badge in the panel);
 *  - a default that cannot be honoured is refused **by name** — never quietly
 *    answered by a different service. These rows carry their own price, so a
 *    substitution would change not only which vendor answered but what the
 *    account was charged.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import {
  createSearchProvider,
  deleteSearchProvider,
  updateSearchProvider,
} from "@/lib/db/search-providers";
import { getSettings, updateSettings } from "@/lib/db/settings";
import {
  backendForRows,
  resolveActiveSearchBackendWithReason,
  resolveSearchBackendByServiceId,
} from "@/lib/search/resolve";

/** Two working services, so "several can answer" is the state under test. */
async function twoServices() {
  const first = await createSearchProvider({
    name: "自建 SearXNG",
    kind: "searxng",
    baseUrl: "https://one.example",
    serviceId: "one",
    priority: 1,
  });
  const second = await createSearchProvider({
    name: "Tavily",
    kind: "tavily",
    baseUrl: "https://api.tavily.com",
    apiKey: "tvly-test",
    serviceId: "two",
    priority: 2,
  });
  return { first, second };
}

/** The environment the resolver is asked with: the rows are what answer. */
const NO_ENV = {} as NodeJS.ProcessEnv;

beforeEach(() => {
  __resetDbForTest();
});

describe("with several services and nobody marked", () => {
  it("the request is refused, and the refusal names the services", async () => {
    await twoServices();
    const { backend, reason } = await resolveActiveSearchBackendWithReason(NO_ENV);
    expect(backend).toBeNull();
    expect(reason).toContain("one");
    expect(reason).toContain("two");
  });
});

describe("with a marked default", () => {
  it("that service answers", async () => {
    const { second } = await twoServices();
    await updateSettings({ searchDefaultServiceId: "two" });

    const { backend, reason } = await resolveActiveSearchBackendWithReason(NO_ENV);
    expect(reason).toBeNull();
    expect(backend?.serviceId).toBe("two");
    expect(backend?.describe).toBe("Tavily");
  });

  it("and the setting reads back", async () => {
    await twoServices();
    await updateSettings({ searchDefaultServiceId: "one" });
    expect((await getSettings()).searchDefaultServiceId).toBe("one");

    // An empty string means "no default", and the setting has to go: a stored
    // empty value would read as a service nobody has.
    await updateSettings({ searchDefaultServiceId: "" });
    expect((await getSettings()).searchDefaultServiceId).toBeUndefined();
  });

  it("that has gone away is refused by name, not replaced", async () => {
    const { first, second } = await twoServices();
    await updateSettings({ searchDefaultServiceId: "one" });
    await deleteSearchProvider(first.id);

    const { backend, reason } = await resolveActiveSearchBackendWithReason(NO_ENV);
    expect(backend).toBeNull();
    // The other service is perfectly able to answer — and it must not, because
    // the operator marked a different one and the prices differ.
    expect(second.serviceId).toBe("two");
    expect(reason).toContain("one");
    expect(reason).toContain("不存在");
  });

  it("that has been switched off is refused by name, not replaced", async () => {
    const { first } = await twoServices();
    await updateSettings({ searchDefaultServiceId: "one" });
    await updateSearchProvider(first.id, { enabled: false });

    const { backend, reason } = await resolveActiveSearchBackendWithReason(NO_ENV);
    expect(backend).toBeNull();
    expect(reason).toContain("one");
    expect(reason).toContain("停用");
  });

  it("does not change what a caller who named a service gets", async () => {
    await twoServices();
    await updateSettings({ searchDefaultServiceId: "two" });

    // The marked default is for the requests that named nobody. A request that
    // named a service still gets that one.
    const named = await resolveSearchBackendByServiceId("one");
    expect(named.problem).toBeNull();
    expect(named.backend?.serviceId).toBe("one");
  });
});

describe("the resolver, on the rows themselves", () => {
  it("a default that names a service nobody has is refused", async () => {
    const { first } = await twoServices();
    const { backend, reason } = backendForRows([first], { defaultServiceId: "ghost" });
    expect(backend).toBeNull();
    expect(reason).toContain("ghost");
  });

  it("and one service alone still answers when nobody marked a default", async () => {
    const { first } = await twoServices();
    const { backend, reason } = backendForRows([first]);
    expect(reason).toBeNull();
    expect(backend?.serviceId).toBe("one");
  });
});
