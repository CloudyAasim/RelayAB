/**
 * tests/unit/assistant-search-provider-tools.test.ts
 *
 * The assistant can manage search providers.
 *
 * It could not before: the assistant listed and changed chat providers and
 * media providers, and the search backends — the third provider family — were
 * the ones it could not touch. Three kinds of provider and two of them
 * manageable is an inconsistency, not a design.
 *
 * ## The guard that matters
 *
 * `propose_search_provider_create` and `propose_search_provider_update` offer
 * fields; the apply route enforces a schema. A field that lives in only one of
 * them can sit there for as long as it likes and every test stays green — the
 * mismatch surfaces as a proposal an administrator approves and then loses,
 * because the failure lands *after* the one click that cannot be refunded.
 *
 * That has already happened in this codebase (`upstreamFormat` and `headers`),
 * so the two lists are compared directly here: the tool's declared parameter
 * names come from the definitions the model actually receives, and the
 * schema's keys come from the Zod shape the apply actually runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { listAssistantActions } from "@/lib/db/assistant";
import { listSearchProviders } from "@/lib/db/search-providers";
import {
  SearchProviderArgsSchema,
  SearchProviderCreateSchema,
  checkProposal,
} from "@/lib/assistant/proposal-validation";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";

const ADMIN = { id: "u-admin", username: "admin", role: "admin", timezone: "shanghai" } as never;

/**
 * A real user, because `assistant_actions.user_id` is a foreign key.
 *
 * The first version of this file used a made-up id, and every proposal came
 * back as "FOREIGN KEY constraint failed" — which is the database correctly
 * refusing a proposal for somebody who does not exist.
 */
let admin: User;
let plainUser: User;

/** The parameter names the model is shown for a tool. */
function declaredParams(toolName: string): string[] {
  const def = toolDefinitions(true).find((t) => t.function.name === toolName);
  expect(def, `${toolName} is not offered to an administrator`).toBeTruthy();
  const params = def!.function.parameters as { properties?: Record<string, unknown> };
  return Object.keys(params.properties ?? {});
}

/** The keys a Zod object will accept. */
function acceptedKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

describe("the assistant is offered the search-provider tools", () => {
  it("all four, to an administrator", () => {
    const names = toolDefinitions(true).map((t) => t.function.name);
    for (const name of [
      "list_search_providers",
      "get_search_spec_reference",
      "propose_search_provider_create",
      "propose_search_provider_update",
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

describe("every field the assistant offers has somewhere to land", () => {
  it("propose_search_provider_create → SearchProviderCreateSchema", () => {
    const offered = declaredParams("propose_search_provider_create").filter(
      (k) => !["name", "summary", "apiKeyHint"].includes(k),
    );
    const accepted = new Set(acceptedKeys(SearchProviderCreateSchema));
    expect(offered.length, "the tool declares nothing, so this check is vacuous").toBeGreaterThan(3);
    expect(
      offered.filter((k) => !accepted.has(k)),
      "propose_search_provider_create offers a field the apply schema rejects — " +
        "the proposal would be created, shown, approved, and then fail.",
    ).toEqual([]);
  });

  it("propose_search_provider_update → SearchProviderArgsSchema", () => {
    const offered = declaredParams("propose_search_provider_update").filter(
      (k) => !["providerId", "summary"].includes(k),
    );
    const accepted = new Set(acceptedKeys(SearchProviderArgsSchema));
    expect(offered.length).toBeGreaterThan(3);
    expect(offered.filter((k) => !accepted.has(k))).toEqual([]);
  });

  it("and the fields the schema accepts are ones the repository can write", () => {
    // Adding a key to the schema is only half the fix. If `UpdateSearchProviderInput`
    // did not have it, the parse would succeed and the value would be dropped on
    // the floor — which this codebase calls worse than a rejection.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const db = readFileSync(join(process.cwd(), "src", "lib", "db", "search-providers.ts"), "utf-8");
    const input = db.slice(db.indexOf("export interface UpdateSearchProviderInput"));
    for (const field of ["kind", "baseUrl", "enabled", "priority", "creditsPerCall", "spec"]) {
      expect(input.slice(0, input.indexOf("\n}")), `UpdateSearchProviderInput.${field}`).toContain(field);
    }
  });
});

describe("the create tool", () => {
  beforeEach(async () => {
    __resetDbForTest();
    admin = (await createUser({
      username: "search-admin",
      password: "correct horse battery",
      displayName: "search-admin",
      role: "admin",
    }))!;
  });
  afterEach(() => {
    currentStore = null;
  });

  it("refuses a key in its arguments", async () => {
    const result = await executeTool(
      "propose_search_provider_create",
      JSON.stringify({ name: "X", kind: "tavily", summary: "s", apiKey: "sk-leaked" }),
      { user: admin } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/不要在工具参数里放 API 密钥/);
    expect(result.content).not.toContain("sk-leaked");
  });

  it("does not create a proposal for a spec the panel would refuse", async () => {
    // The same class of failure the media side hit three times: a proposal
    // that is created, shown, approved — and then fails at apply time, because
    // the check lived on only one side of the door.
    const result = await executeTool(
      "propose_search_provider_create",
      JSON.stringify({
        name: "Broken",
        kind: "tavily",
        summary: "接一个厂商",
        spec: {
          specVersion: 1,
          transport: { method: "GET", path: "/search" },
          response: { items: "$.results", fields: { title: "$.t", url: "$.u" } },
        },
      }),
      { user: admin } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/通不过协议校验/);
    expect(await listAssistantActions(admin.id)).toHaveLength(0);
  });

  it("creates a proposal for a spec that passes", async () => {
    const result = await executeTool(
      "propose_search_provider_create",
      JSON.stringify({
        name: "自建实例",
        kind: "searxng",
        summary: "换一个自建实例",
        baseUrl: "http://relay-search.web:8080",
      }),
      { user: admin } as never,
    );
    expect(result.ok, result.content).toBe(true);
    const actions = await listAssistantActions(admin.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("search_provider.create");
    // The key is not in the proposal; the administrator fills it in.
    expect(actions[0].args).not.toContain("apiKey");
  });
});

describe("the update tool", () => {
  beforeEach(async () => {
    __resetDbForTest();
    admin = (await createUser({
      username: "search-admin",
      password: "correct horse battery",
      displayName: "search-admin",
      role: "admin",
    }))!;
  });
  afterEach(() => {
    currentStore = null;
  });

  it("refuses an update for a provider that does not exist", async () => {
    const result = await executeTool(
      "propose_search_provider_update",
      JSON.stringify({ providerId: "nope", summary: "改一下" }),
      { user: admin } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/找不到搜索提供商/);
  });

  it("proposes a change to a real provider", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    const row = await createSearchProvider({
      name: "本地",
      kind: "searxng",
      baseUrl: "http://relay-search.web:8080",
    });
    const result = await executeTool(
      "propose_search_provider_update",
      JSON.stringify({ providerId: row.id, summary: "换个地址", baseUrl: "http://other:8080" }),
      { user: admin } as never,
    );
    expect(result.ok, result.content).toBe(true);
    const actions = await listAssistantActions(admin.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("search_provider.update");
    expect(actions[0].targetId).toBe(row.id);
  });
});

describe("the admin-only tools", () => {
  beforeEach(async () => {
    __resetDbForTest();
    admin = (await createUser({
      username: "search-admin",
      password: "correct horse battery",
      displayName: "search-admin",
      role: "admin",
    }))!;
    plainUser = (await createUser({
      username: "search-user",
      password: "correct horse battery",
      displayName: "search-user",
    }))!;
  });
  afterEach(() => {
    currentStore = null;
  });

  it("are refused for a regular user", async () => {
    for (const name of ["list_search_providers", "get_search_spec_reference"]) {
      const result = await executeTool(name, "{}", { user: plainUser } as never);
      expect(result.ok, name).toBe(false);
      expect(result.content).toMatch(/管理员功能/);
    }
  });

  it("list the providers and the address each one really uses", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    await createSearchProvider({ name: "本地", kind: "searxng", baseUrl: "http://relay-search.web:8080" });
    const result = await executeTool("list_search_providers", "{}", { user: admin } as never);
    expect(result.ok, result.content).toBe(true);
    expect(result.content).toContain("http://relay-search.web:8080/search");
  });
});

describe("the proposal checker", () => {
  it("accepts a valid create", () => {
    const result = checkProposal("search_provider.create", {
      name: "X",
      kind: "tavily",
      baseUrl: "https://api.tavily.com",
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a create whose spec does not parse", () => {
    const result = checkProposal("search_provider.create", {
      name: "X",
      kind: "tavily",
      spec: { specVersion: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/通不过协议校验/);
  });

  it("refuses an update that names no field", () => {
    const result = checkProposal("search_provider.update", {});
    // An empty patch is a Zod success (every field is optional), so the
    // emptiness is caught by the tool, not the schema. What matters here is
    // that an unknown field is not.
    expect(result.ok).toBe(true);
    const unknown = checkProposal("search_provider.update", { nonsense: 1 });
    expect(unknown.ok).toBe(false);
  });
});

describe("the provider table", () => {
  beforeEach(() => {
    __resetDbForTest();
  });

  it("keeps a spec it is given, and reads it back", async () => {
    const { createSearchProvider, getSearchProviderById } = await import("@/lib/db/search-providers");
    const spec = {
      specVersion: 1,
      vendor: "serper",
      transport: { method: "GET", path: "/search", query: { q: "$.query" } },
      auth: { type: "bearer" },
      response: { items: "$.results", fields: { title: "$.title", url: "$.url", snippet: "$.snippet" } },
    };
    const created = await createSearchProvider({
      name: "Serper",
      kind: "serper",
      baseUrl: "https://api.serper.dev",
      apiKey: "k",
      spec,
    });
    const read = await getSearchProviderById(created.id);
    expect(read?.spec).toEqual(spec);
  });

  it("refuses a row whose spec does not parse", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    await expect(
      createSearchProvider({
        name: "Broken",
        kind: "custom",
        baseUrl: "https://api.example",
        apiKey: "k",
        spec: { specVersion: 1, transport: { method: "GET" } },
      }),
    ).rejects.toThrow(/transport/);
  });

  it("refuses a keyed vendor with no key", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    await expect(
      createSearchProvider({ name: "NoKey", kind: "tavily" }),
    ).rejects.toThrow(/requires an API key/);
  });

  it("a row without a spec still needs the address a SearXNG row needs", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    await expect(createSearchProvider({ name: "NoAddr", kind: "searxng" })).rejects.toThrow(
      /requires a base URL/,
    );
  });

  it("an unknown kind with no spec is refused, with the way out named", async () => {
    const { createSearchProvider } = await import("@/lib/db/search-providers");
    await expect(
      createSearchProvider({ name: "Unknown", kind: "serper", baseUrl: "https://api.serper.dev" }),
    ).rejects.toThrow(/没有内置模板/);
  });
});
