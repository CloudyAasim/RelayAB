/**
 * tests/unit/assistant-model-limits-for-regular-users.test.ts
 *
 * A regular user asked what models the gateway serves and how big their context
 * windows are, and got a list of names and the sentence "上下文窗口是管理员配置，
 * 我没有管理员权限读不到".
 *
 * Two things were wrong and neither was a permission.
 *
 * `list_gateway_models` returned names only. The figures were on the catalogue
 * the model page renders from — already filtered by the same rule that page uses
 * — so the answer existed, was reachable by exactly this caller, and the tool
 * simply did not carry it. The assistant read the prose page describing *how*
 * models are configured, found no table, and concluded the numbers were
 * admin-only.
 *
 * And the prompt sent it to `list_providers`, which is an admin tool a regular
 * user does not have, when `list_gateway_models` is the one that answers it.
 *
 * The second half of this file is the other half of that promise: a key must
 * not learn the *name* of a model it may not call. The figures and the names
 * are one answer, scoped to one credential — an assistant that reads out a name
 * the proxy then refuses turns "it is on the list" into a 403.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import type { AccountCredential } from "@/lib/assistant/credentials";
import { USER_SYSTEM_PROMPT } from "@/lib/assistant/prompts";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider } from "@/lib/db/providers";
import { createMediaProvider } from "@/lib/db/media-providers";
import { createUser } from "@/lib/db/users";
import { createApiKey } from "@/lib/db/keys";
import type { AuthedUser } from "@/lib/auth/session";
import type { ApiKey, User } from "@/lib/db/types";

type ModelsResult = {
  chatModels: string[];
  mediaModels: string[];
  total: number;
  providers: Array<{ name: string; baseUrl: string | null; models: string[] }>;
  chat: Array<{
    id: string;
    contextLength: number | null;
    maxOutputTokens: number | null;
    reasoning: {
      levels: string[];
      effortSupported: boolean | null;
      switchSupported: boolean | null;
    };
  }>;
};

/**
 * The account allows everything seeded; the narrow key is the variable the
 * scoping tests move. Tests that are not about scoping use the wide key, so
 * their loops have a body to run over — an empty `chat` array would make every
 * assertion inside it vacuously true, and a guard that cannot fail is
 * indistinguishable from one that passes.
 */
let owner: User;
let narrow: { key: ApiKey; plainKey: string };
let wide: { key: ApiKey; plainKey: string };

const authed = (): AuthedUser => ({
  id: owner.id,
  username: owner.username,
  role: "user",
  timezone: "utc",
});

beforeEach(async () => {
  await __resetDbForTest();
  await createProvider({
    name: "MiniMax",
    kind: "openai",
    apiKey: "sk-seed",
    baseUrl: "https://api.minimax.cn/v1",
    modelMapping: { "MiniMax-M3": "MiniMax-M3", "MiniMax-M3.1-Flash-Preview": "MiniMax-M3.1" },
    modelConfigs: {
      // No levels, and declared unswitchable — the case that reads as "no
      // levels" if the two facts are separated.
      "MiniMax-M3": {
        upstreamId: "MiniMax-M3",
        clientId: "MiniMax-M3",
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningLevels: [],
        reasoningEffortSupported: false,
        thinkingSwitchSupported: false,
        inputCost: 420,
        outputCost: 1680,
        enabled: true,
      },
      "MiniMax-M3.1-Flash-Preview": {
        upstreamId: "MiniMax-M3.1-Flash-Preview",
        clientId: "MiniMax-M3.1-Flash-Preview",
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
        thinkingSwitchSupported: false,
        inputCost: 420,
        outputCost: 1680,
        enabled: true,
      },
    },
    enabled: true,
  });
  await createMediaProvider({
    name: "Seedance",
    baseUrl: "https://api.seedance.test",
    apiKey: "sk-media-seed",
    mode: "spec",
    models: {
      "seedance-1-lite": { upstreamId: "seedance-1-lite", pricePerItem: 1, enabled: true },
      "seedance-1-pro": { upstreamId: "seedance-1-pro", pricePerItem: 2, enabled: true },
      // Switched off at the model level: unusable no matter what the whitelist says.
      "seedance-off": { upstreamId: "seedance-off", pricePerItem: 1, enabled: false },
    },
  });
  owner = await createUser({
    username: "models",
    password: "pw-models-test-1",
    role: "user",
    allowedModels: [
      "MiniMax-M3",
      "MiniMax-M3.1-Flash-Preview",
      "seedance-1-lite",
      "seedance-1-pro",
      "seedance-off",
    ],
  });
  narrow = await createApiKey({
    userId: owner.id,
    label: "narrow",
    allowedModels: ["MiniMax-M3", "seedance-1-lite"],
  });
  wide = await createApiKey({ userId: owner.id, label: "wide" });
});

/**
 * The tool reads its scope from the credential the turn carries, so each case
 * says which one it means: a pasted key, an account credential, or neither.
 */
async function list(credential: {
  relayKey?: string;
  account?: AccountCredential;
}): Promise<ModelsResult> {
  const result = await executeTool("list_gateway_models", "{}", {
    user: authed(),
    ...credential,
  });
  expect(result.ok, result.content.slice(0, 400)).toBe(true);
  return JSON.parse(result.content) as ModelsResult;
}

const readChat = async () => (await list({ relayKey: wide.plainKey })).chat;

describe("the model list carries the numbers", () => {
  it("has rows to check, so the rest of these cannot pass vacuously", async () => {
    // Put first, deliberately: without it every loop below runs zero times and
    // the file goes green while testing nothing.
    const chat = await readChat();
    expect(chat.length, "no models came back, so the assertions below proved nothing").toBe(2);
  });

  it("names the three limits a name cannot imply", async () => {
    for (const row of await readChat()) {
      expect(row, "every row is missing its limits").toHaveProperty("contextLength");
      expect(row).toHaveProperty("maxOutputTokens");
      expect(Array.isArray(row.reasoning.levels)).toBe(true);
    }
  });

  it("carries all three thinking facts together, never one of them alone", async () => {
    // The tool previously returned `reasoningLevels` and nothing else, so a model
    // reading `[]` could not tell "no levels published" from "cannot be switched
    // off" — the three-way collapse the model page used to have, reappearing one
    // layer down. The fix is the shape: one object holding all three, so the
    // caller has nothing to remember to join.
    for (const row of await readChat()) {
      expect(Object.keys(row.reasoning).sort()).toEqual([
        "effortSupported",
        "levels",
        "switchSupported",
      ]);
      // `null` means undeclared, which is a different answer from `false`.
      expect([true, false, null]).toContain(row.reasoning.effortSupported);
      expect([true, false, null]).toContain(row.reasoning.switchSupported);
    }
  });

  it("and the awkward model is still readable as three separate answers", async () => {
    // The seeded model is the one that cannot be described by its levels alone:
    // no levels *and* unswitchable. If any of the three collapses, this is where
    // it shows.
    const chat = await readChat();
    const m3 = chat.find((r) => r.id === "MiniMax-M3");
    expect(m3?.reasoning.levels).toEqual([]);
    expect(m3?.reasoning.effortSupported).toBe(false);
    expect(m3?.reasoning.switchSupported).toBe(false);

    const m31 = chat.find((r) => r.id === "MiniMax-M3.1-Flash-Preview");
    expect(m31?.reasoning.levels.length).toBe(5);
    expect(m31?.reasoning.switchSupported).toBe(false);
  });

  it("and the description says all three must be reported together", () => {
    const def = toolDefinitions(false).find((t) => t.function.name === "list_gateway_models")!;
    expect(def.function.description).toMatch(/switchSupported/);
    expect(def.function.description).toMatch(/effortSupported/);
    expect(def.function.description).toMatch(/一起/);
  });

  it("and the tool description says the numbers are in there", () => {
    // The description is the only thing the model reads before deciding which
    // tool to call. A number nobody is told about does not get asked for.
    const def = toolDefinitions(false).find((t) => t.function.name === "list_gateway_models")!;
    expect(def.function.description).toMatch(/上下文/);
    expect(def.function.description).toMatch(/思考/);
  });

  it("and it is the user tool, not an admin one", () => {
    // The whole point: this is the question a non-admin asks most, so it has to
    // be answerable by the non-admin tool set.
    expect(toolDefinitions(false).map((t) => t.function.name)).toContain("list_gateway_models");
    expect(toolDefinitions(false).map((t) => t.function.name)).not.toContain("list_providers");
  });
});

describe("the list is scoped to the credential, not the deployment", () => {
  it("a key narrower than its account hides what it may not call", async () => {
    const result = await list({ relayKey: narrow.plainKey });

    expect(result.chatModels).toEqual(["MiniMax-M3"]);
    expect(result.mediaModels).toEqual(["seedance-1-lite"]);
    expect(result.total).toBe(2);
    expect(result.providers.map((p) => p.name)).toEqual(["MiniMax"]);
    expect(result.providers.flatMap((p) => p.models)).toEqual(["MiniMax-M3"]);
    expect(result.chat.map((c) => c.id)).toEqual(["MiniMax-M3"]);
  });

  it("and the forbidden names appear in none of the fields", async () => {
    // A name in `providers[].models` is as good as a name in `chatModels` to
    // whoever reads this JSON out loud.
    const text = JSON.stringify(await list({ relayKey: narrow.plainKey }));
    expect(text).not.toContain("MiniMax-M3.1-Flash-Preview");
    expect(text).not.toContain("seedance-1-pro");
    expect(text).not.toContain("seedance-off");
  });

  it("the account credential gets the same narrowing", async () => {
    const result = await list({
      account: { apiKey: narrow.key, user: owner },
    });
    expect(result.chatModels).toEqual(["MiniMax-M3"]);
    expect(result.mediaModels).toEqual(["seedance-1-lite"]);
  });

  it("an empty key list inherits the account rather than meaning nothing", async () => {
    // `[]` is "no extra restriction" everywhere else in the product; reading it
    // as "no models" here would make an unrestricted key look suspended.
    const result = await list({ relayKey: wide.plainKey });
    expect(result.chatModels).toEqual(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview"]);
    // `seedance-off` is switched off at the model level, so it is not callable.
    expect(result.mediaModels).toEqual(["seedance-1-lite", "seedance-1-pro"]);
  });

  it("with no credential at all, the account's own whitelist is the boundary", async () => {
    // The session carries no key. Falling back to the full deployment would be
    // the leak; the account list is the most this caller could ever call.
    const result = await list({});
    expect(result.chatModels).toEqual(["MiniMax-M3", "MiniMax-M3.1-Flash-Preview"]);
    expect(result.mediaModels).toEqual(["seedance-1-lite", "seedance-1-pro"]);
  });

  it("and a restricted account sees only its own list even with no credential", async () => {
    const restricted = await createUser({
      username: "restricted",
      password: "pw-models-test-2",
      role: "user",
      allowedModels: ["MiniMax-M3"],
    });
    const result = await executeTool("list_gateway_models", "{}", {
      user: { id: restricted.id, username: restricted.username, role: "user", timezone: "utc" },
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.content) as ModelsResult;
    expect(parsed.chatModels).toEqual(["MiniMax-M3"]);
    expect(parsed.mediaModels).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain("MiniMax-M3.1-Flash-Preview");
  });

  it("a pasted key that does not resolve is refused, not widened to the account", async () => {
    // The caller asked to be limited to this key. Falling back to the account
    // would answer a different question with more than was asked for.
    const result = await executeTool("list_gateway_models", "{}", {
      user: authed(),
      relayKey: "sk-relay-does-not-exist",
    });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/查不到|does not exist/);
    expect(result.content).not.toContain("MiniMax");
  });
});

describe("the prompt stops sending this question to the wrong tool", () => {
  it("routes the limits question to the tool that has them", () => {
    // `list_providers` is admin-only. Pointing a regular user's question at it
    // is what produced "我没有管理员权限" for a figure that was never admin-only.
    const section = USER_SYSTEM_PROMPT.slice(
      USER_SYSTEM_PROMPT.indexOf("## 先读配置"),
      USER_SYSTEM_PROMPT.indexOf("## 空数组不说明任何事"),
    );
    expect(section).toMatch(/先 list_gateway_models/);
    expect(section).toMatch(/只有在管理员模式下才需要/);
  });

  it("and says the question is in the parameters pages, not admin config", () => {
    // The pages exist, they are readable by a regular user, and the assistant
    // listed them and then read a different one.
    expect(USER_SYSTEM_PROMPT).toMatch(/user:parameters#…/);
  });

  it("and makes 「我看不到」 a last resort rather than an opening", () => {
    expect(USER_SYSTEM_PROMPT).toMatch(/不要把「我看不到」当成一个可以轻易说出口的答案/);
  });

  it("and requires the three thinking facts to be answered in one shape", () => {
    // "放在一起讲" was too abstract to survive contact with a model that has a
    // table right there. What can be followed is a named shape with named
    // columns, so the prompt says which one.
    expect(USER_SYSTEM_PROMPT).toMatch(/在同一条回答、同一个表格里/);
    expect(USER_SYSTEM_PROMPT).toMatch(/思考档位 \/ 能否调深度 \/ 能否关掉/);
    expect(USER_SYSTEM_PROMPT).toMatch(/这是.{0,6}一条.{0,4}能力，不是三项独立设置/);
  });
});