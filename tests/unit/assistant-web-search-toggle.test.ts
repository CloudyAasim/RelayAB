/**
 * tests/unit/assistant-web-search-toggle.test.ts
 *
 * "Off" has to mean off in three places, and this file checks all three:
 *
 *  1. the tool is not offered to the model,
 *  2. a model that calls it anyway is refused (hiding a definition does not
 *     un-teach a name the model saw in an earlier turn),
 *  3. the conversation remembers the choice across a reload.
 *
 * It also pins the result-count clamp: the user's setting is a ceiling, not a
 * suggestion, and the model cannot ask for more than the operator allows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

let currentStore: import("@/lib/auth/session").InMemoryCookieStore | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => currentStore,
}));

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createUser } from "@/lib/db/users";
import type { User } from "@/lib/db/types";
import { InMemoryCookieStore, getSessionFromStore } from "@/lib/auth/session";
import { createAssistantThread, getAssistantThread } from "@/lib/db/assistant";
import { executeTool, toolDefinitions } from "@/lib/assistant/tools";
import { DEFAULT_WEB_SEARCH_LIMIT } from "@/lib/search/usage";
import { MAX_SEARCH_RESULTS } from "@/lib/assistant/web-search";
import { PATCH } from "@/app/api/assistant/threads/[id]/route";

const SRC = join(__dirname, "..", "..", "src");
const CHAT_UI = readFileSync(
  join(SRC, "app", "(user)", "dashboard", "assistant", "AssistantChat.tsx"),
  "utf-8",
);

const SEARCH_ENV = ["TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "SEARXNG_URL"] as const;
let savedEnv: Array<readonly [string, string | undefined]> = [];

async function makeUser(username: string): Promise<User> {
  const name = username.padEnd(3, "x");
  const user = await createUser({ username: name, password: "correct horse battery", displayName: name });
  expect(user).not.toBeNull();
  return user!;
}

async function loginAs(store: InMemoryCookieStore, user: User): Promise<void> {
  const s = await getSessionFromStore(store);
  s.userId = user.id;
  s.username = user.username;
  s.role = user.role;
  await s.save();
}

function ctxFor(userId: string, over: Record<string, unknown> = {}) {
  return {
    user: { id: userId, username: "u", role: "user", timezone: "shanghai" },
    ...over,
  } as never;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  __resetDbForTest();
  currentStore = null;
  savedEnv = SEARCH_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of SEARCH_ENV) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("tool catalogue", () => {
  it("offers web_search when the turn allows it", () => {
    for (const tier of [true, false]) {
      expect(toolDefinitions(tier, { webSearch: true }).map((t) => t.function.name)).toContain(
        "web_search",
      );
      // No opinion means on, so existing callers keep today's catalogue.
      expect(toolDefinitions(tier).map((t) => t.function.name)).toContain("web_search");
    }
  });

  it("removes it when the turn does not, and removes nothing else", () => {
    for (const tier of [true, false]) {
      const off = toolDefinitions(tier, { webSearch: false }).map((t) => t.function.name);
      const on = toolDefinitions(tier, { webSearch: true }).map((t) => t.function.name);
      expect(off).not.toContain("web_search");
      expect(off).toEqual(on.filter((name) => name !== "web_search"));
    }
  });
});

describe("execution refusal", () => {
  it("refuses a call the turn said not to make, without touching the network", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool(
      "web_search",
      JSON.stringify({ query: "anything" }),
      ctxFor("u1", { webSearchEnabled: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/本轮已关闭网页搜索/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("result-count clamp", () => {
  function braveFetch() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({ web: { results: [{ title: "A", url: "https://a.example/", description: "a" }] } }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  }

  async function countFor(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
    process.env.BRAVE_SEARCH_API_KEY = "k";
    const fetchMock = braveFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeTool("web_search", JSON.stringify(args), ctxFor("u1", ctx));
    expect(result.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    return Number(new URL(url).searchParams.get("count"));
  }

  it("uses the user's setting as the ceiling", async () => {
    expect(await countFor({ query: "q", limit: 9 }, { webSearchLimit: 3 })).toBe(3);
  });

  it("never exceeds the hard maximum even if the setting does", async () => {
    expect(await countFor({ query: "q", limit: 50 }, { webSearchLimit: 99 })).toBe(MAX_SEARCH_RESULTS);
  });

  it("honours a smaller model request", async () => {
    expect(await countFor({ query: "q", limit: 2 }, { webSearchLimit: 5 })).toBe(2);
  });

  it("defaults when nothing states a preference", async () => {
    expect(await countFor({ query: "q" })).toBe(DEFAULT_WEB_SEARCH_LIMIT);
  });
});

describe("thread persistence", () => {
  function patchBody(body: unknown): Request {
    return new Request("http://localhost/api/assistant/threads/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("stores the toggle and reads it back", async () => {
    const user = await makeUser("alice");
    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user);
    const thread = await createAssistantThread(user.id, "测试");
    expect(thread.webSearch).toBeNull();

    const off = await PATCH(patchBody({ webSearch: false }), ctx(thread.id));
    expect(off.status).toBe(200);
    expect((await getAssistantThread(user.id, thread.id))?.webSearch).toBe(false);

    const on = await PATCH(patchBody({ webSearch: true }), ctx(thread.id));
    expect(on.status).toBe(200);
    expect((await getAssistantThread(user.id, thread.id))?.webSearch).toBe(true);
  });

  it("does not let someone else flip another person's conversation", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    const thread = await createAssistantThread(owner.id, "私密");

    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, other);
    const res = await PATCH(patchBody({ webSearch: false }), ctx(thread.id));
    expect(res.status).toBe(404);
    expect((await getAssistantThread(owner.id, thread.id))?.webSearch).toBeNull();
  });

  it("rejects an empty patch", async () => {
    const user = await makeUser("empty");
    currentStore = new InMemoryCookieStore();
    await loginAs(currentStore, user);
    const thread = await createAssistantThread(user.id, "t");
    expect((await PATCH(patchBody({}), ctx(thread.id))).status).toBe(400);
  });
});

describe("composer wiring", () => {
  it("sends the choice with the message and persists it", () => {
    // The toggle is a client component; what can be checked here is that the
    // three behaviours the route depends on are actually present.
    expect(CHAT_UI).toMatch(/webSearch/);
    expect(CHAT_UI).toMatch(/aria-pressed/);
    expect(CHAT_UI).toMatch(/api\/assistant\/threads\/\$\{[^}]+\}/);
  });
});
