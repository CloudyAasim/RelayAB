/**
 * tests/unit/assistant-provider-active-mode.test.ts
 *
 * A provider can hold parameter rules that nothing executes.
 *
 * `activeSpecFor` returns null unless `activeModeOf` resolves to "advanced".
 * The stored column may be null, in which case the mode is inferred from
 * whether rules exist — so the same visible state means two different things
 * depending on a field the panel shows as a toggle and the assistant could
 * write `textSpecs` without ever touching. AgnesCN was exactly this: rules
 * saved, mode `simple`, behaviour identical to having no rules at all.
 *
 * Three things have to hold for the fix to be real:
 *
 *  - the tool can say which set is live (`activeMode` reaches the patch);
 *  - writing rules while the engine reads `simple` is reported *before* the
 *    administrator approves, not discovered as "the config did nothing";
 *  - the diff shows the effective mode on both sides, because "- (空)"
 *    above "+ advanced" tells the reader nothing about what will change.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider, getProviderById } from "@/lib/db/providers";
import { createUser } from "@/lib/db/users";
import { executeTool, type ToolResult } from "@/lib/assistant/tools";
import { renderProviderDiff } from "@/lib/assistant/diff";
import { protocolPreset } from "@/lib/protocol/text-protocols";
import type { Provider } from "@/lib/db/types";

const CHAT_RULE = protocolPreset("openai-chat");

/** The proposals carry a user id that has to exist: the row has a foreign key. */
let adminId = "";

function propose(args: Record<string, unknown>): Promise<ToolResult> {
  return executeTool(
    "propose_provider_update",
    JSON.stringify({ summary: "测试", ...args }),
    { user: { id: adminId, role: "admin" } } as never,
  );
}

/** The payload handed back to the model, which is what it acts on. */
function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

async function providerWith(rules: number, mode: "simple" | "advanced" | null = null) {
  return createProvider({
    name: "Agnes",
    kind: "openai",
    apiKey: "sk-upstream",
    modelMapping: { "agnes-3": "agnes-3" },
    textSpecs: rules > 0 ? [JSON.stringify(CHAT_RULE)] : [],
    activeMode: mode,
  });
}

beforeEach(async () => {
  __resetDbForTest();
  const admin = await createUser({ username: "admin", password: "pw-123456", role: "admin" });
  adminId = admin.id;
});

describe("switching the rule set", () => {
  it("is written into the proposal when the provider already has rules", async () => {
    const provider = await providerWith(1, "simple");

    const result = await propose({ providerId: provider.id, activeMode: "advanced" });
    expect(result.ok).toBe(true);
    expect(payload(result).status).not.toBe("needs_attention");

    const stored = await getProviderById(provider.id);
    // A proposal by definition writes nothing; approving does.
    expect(stored?.activeMode).toBe("simple");

    const diff = String(payload(result).diff ?? "");
    expect(diff).toContain("参数规则读取模式");
    expect(diff).toContain("+ advanced");
  });

  it("is refused when it would change nothing", async () => {
    // No rules, and none being added. `advanced` on an empty provider is the
    // same "forward as sent" the engine already does under `simple`, so the
    // diff would show a change in search of a behaviour.
    const provider = await providerWith(0, "simple");

    const result = await propose({ providerId: provider.id, activeMode: "advanced" });
    expect(result.ok).toBe(true);
    const body = payload(result);
    expect(body.status).toBe("needs_attention");
    expect(String(body.message)).toContain("一条参数规则都没有");
    expect(body.diff).toBeUndefined();
  });

  it("is allowed when the same proposal creates the rules it applies", async () => {
    const provider = await providerWith(0, "simple");

    const result = await propose({
      providerId: provider.id,
      activeMode: "advanced",
      textSpecs: [CHAT_RULE],
    });
    const body = payload(result);
    expect(body.status).not.toBe("needs_attention");
    expect(body.diff).toBeTruthy();
  });
});

describe("writing rules the engine will not read", () => {
  it("is reported rather than silently saved", async () => {
    // The AgnesCN shape: a full rule set, mode `simple`. Everything in the
    // panel reads as configured, and no request is ever rewritten.
    const provider = await providerWith(0, "simple");

    const result = await propose({ providerId: provider.id, textSpecs: [CHAT_RULE] });
    const body = payload(result);
    expect(body.status).toBe("needs_attention");
    expect(String(body.message)).toContain("simple");
    expect(String(body.message)).toContain("不会执行");
  });

  it("is not reported when the same proposal switches the mode too", async () => {
    const provider = await providerWith(0, "simple");

    const result = await propose({
      providerId: provider.id,
      textSpecs: [CHAT_RULE],
      activeMode: "advanced",
    });
    expect(payload(result).status).not.toBe("needs_attention");
  });

  it("is not reported when the mode was never set and the rules make it advanced", async () => {
    // `null` means "read whatever rules it has". A project that has always
    // worked this way must not be asked to confirm a mode it never chose.
    const provider = await providerWith(1, null);

    const result = await propose({ providerId: provider.id, textSpecs: [CHAT_RULE] });
    expect(payload(result).status).not.toBe("needs_attention");
  });
});

describe("the diff shows the mode the engine actually reads", () => {
  const base = {
    id: "p1",
    name: "Agnes",
    modelMapping: {},
    modelConfigs: {},
    textSpecs: [JSON.stringify(CHAT_RULE)],
    activeMode: null,
  } as unknown as Provider;

  it("resolves a null stored value on the before side", () => {
    // Otherwise the administrator reads "- (空)" and has to know the inference
    // rule from somewhere that is not on the screen.
    const diff = renderProviderDiff({ ...base, activeMode: null }, { activeMode: "simple" }, "s");
    expect(diff).toContain("参数规则读取模式");
    expect(diff).toContain("- advanced");
    expect(diff).toContain("未显式设置");
    expect(diff).toContain("+ simple");
    expect(diff).toContain("完全不执行");
  });

  it("counts the rules the proposal creates, not the ones already stored", () => {
    const diff = renderProviderDiff(
      { ...base, textSpecs: [], activeMode: "simple" } as unknown as Provider,
      { activeMode: "advanced", textSpecs: [JSON.stringify(CHAT_RULE)] },
      "s",
    );
    expect(diff).toContain("1 条规则将参与改写上游请求");
  });

  it("is absent when the patch does not touch it", () => {
    const diff = renderProviderDiff({ ...base, activeMode: "simple" }, { enabled: false }, "s");
    expect(diff).not.toContain("参数规则读取模式");
  });
});
