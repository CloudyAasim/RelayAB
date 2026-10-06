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
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolDefinitions, executeTool } from "@/lib/assistant/tools";
import { USER_SYSTEM_PROMPT } from "@/lib/assistant/prompts";
import type { AuthedUser } from "@/lib/auth/session";

const TOOLS = readFileSync(join(process.cwd(), "src", "lib", "assistant", "tools.ts"), "utf-8");

const user: AuthedUser = { id: "u-models", username: "models", role: "user", timezone: "utc" };

describe("the model list carries the numbers", () => {
  it("names the three limits a name cannot imply", async () => {
    const result = await executeTool("list_gateway_models", "{}", { user, relayKey: "sk-relay-x" });
    expect(result.ok, result.content.slice(0, 200)).toBe(true);
    const payload = JSON.parse(result.content) as {
      chat: Array<{
        id: string;
        contextLength: number | null;
        maxOutputTokens: number | null;
        reasoningLevels: string[];
      }>;
    };
    expect(Array.isArray(payload.chat)).toBe(true);
    for (const row of payload.chat) {
      expect(row, "every row is missing its limits").toHaveProperty("contextLength");
      expect(row).toHaveProperty("maxOutputTokens");
      expect(Array.isArray(row.reasoningLevels)).toBe(true);
    }
  });

  it("and the tool description says the numbers are in there", () => {
    // The description is the only thing the model reads before deciding which
    // tool to call. A number nobody is told about does not get asked for.
    const def = toolDefinitions(false).find((t) => t.function.name === "list_gateway_models")!;
    expect(def.function.description).toMatch(/上下文/);
    expect(def.function.description).toMatch(/思考等级/);
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
});