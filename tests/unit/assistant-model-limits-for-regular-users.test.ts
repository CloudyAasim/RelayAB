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
 */
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import { USER_SYSTEM_PROMPT } from "@/lib/assistant/prompts";
import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider } from "@/lib/db/providers";
import type { AuthedUser } from "@/lib/auth/session";

const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

const user: AuthedUser = { id: "u-models", username: "models", role: "user", timezone: "utc" };

/**
 * A provider with a model whose thinking state is the awkward one.
 *
 * The empty levels list is shared by a model that takes no levels *and* a model
 * that cannot be switched off, which is the whole reason the two declarations
 * travel with it. Seeding gives the loop a body to run over — an empty
 * `chat` array would make every assertion inside it vacuously true, and a guard
 * that cannot fail is indistinguishable from one that passes.
 */
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
});

const readChat = async (): Promise<
  Array<{
    id: string;
    contextLength: number | null;
    maxOutputTokens: number | null;
    reasoning: { levels: string[]; effortSupported: boolean | null; switchSupported: boolean | null };
  }>
> => {
  const result = await executeTool("list_gateway_models", "{}", { user, relayKey: "sk-relay-x" });
  expect(result.ok, result.content.slice(0, 300)).toBe(true);
  return (JSON.parse(result.content) as { chat: never[] }).chat;
};

describe("the model list carries the numbers", () => {
  it("has rows to check, so the rest of these cannot pass vacuously", () => {
    // Put first, deliberately: without it every loop below runs zero times and
    // the file goes green while testing nothing.
    return readChat().then((chat) => {
      expect(chat.length, "no models came back, so the assertions below proved nothing").toBe(2);
    });
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

  it("filtered by the same whitelist the model page uses", () => {
    // Both must apply one rule, or the assistant and the page disagree about
    // what this account can see — which is the bug being fixed.
    expect(TOOLS).toMatch(/const allowed = full\?\.allowedModels \?\? \[\];/);
    expect(TOOLS).toMatch(/allowed\.length === 0 \|\| allowed\.includes\(id\)/);
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