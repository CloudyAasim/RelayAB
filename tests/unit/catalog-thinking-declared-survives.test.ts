/**
 * tests/unit/catalog-thinking-declared-survives.test.ts
 *
 * The three states of a thinking flag, checked through the database rather than
 * around it.
 *
 * A model with a working on/off switch and no gear-shifted levels was being
 * described as "always on, no levels to choose" — the answer for a model that
 * cannot be switched off. The switch had been declared correctly, and the value
 * was lost on the way out: `ModelConfigSchema` filled every absent field in with
 * `true`, so "nobody has said" and "somebody said yes" were the same value by
 * the time anything read it, and the read then folded `true` back into "nobody
 * has said" to be consistent.
 *
 * Both halves of that are invisible to a test that builds a model object by
 * hand. These go through SQLite, which is where the value was being lost.
 */
import { describe, it, expect, beforeEach } from "vitest";

import { __resetDbForTest } from "@/lib/db/sqlite";
import { createProvider } from "@/lib/db/providers";
import { buildModelCatalog } from "@/lib/docs/catalog";
import { thinkingShape } from "@/lib/docs/thinking";

/** Three models: the three answers, differing only in what was declared. */
async function seedThinking(): Promise<void> {
  await createProvider({
    name: "MiniMax",
    kind: "openai",
    apiKey: "sk-a",
    baseUrl: "https://api.minimax.cn/v1",
    modelMapping: { "M3": "M3", "M2.7": "M2.7", "undeclared": "undeclared" },
    modelConfigs: {
      // A switch and no gears. This is the model the docs page got wrong.
      M3: {
        upstreamId: "M3",
        clientId: "M3",
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningLevels: [],
        reasoningEffortSupported: false,
        thinkingSwitchSupported: true,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
      // Neither: it reasons every time and cannot be told not to.
      "M2.7": {
        upstreamId: "M2.7",
        clientId: "M2.7",
        contextLength: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningLevels: [],
        reasoningEffortSupported: false,
        thinkingSwitchSupported: false,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
      // Nobody has said anything about this one.
      undeclared: {
        upstreamId: "undeclared",
        clientId: "undeclared",
        contextLength: 200_000,
        maxOutputTokens: 8_000,
        reasoningLevels: [],
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
    },
    enabled: true,
  });
}

describe("what the docs page says about a model's thinking", () => {
  beforeEach(async () => {
    await __resetDbForTest();
    await seedThinking();
  });

  it("tells a model with a switch apart from one that cannot be switched off", async () => {
    const cat = await buildModelCatalog();
    const m3 = cat.models.find((m) => m.id === "M3");
    const m27 = cat.models.find((m) => m.id === "M2.7");

    // The two differ by one boolean, and the page has to be able to say so.
    expect(m3?.thinkingSwitchSupported).toBe(true);
    expect(m27?.thinkingSwitchSupported).toBe(false);

    expect(thinkingShape(m3!)).toBe("switchOnly");
    expect(thinkingShape(m27!)).toBe("alwaysOn");
  });

  it("keeps a declared yes from being reported as nobody having said", async () => {
    // The failure this file exists for: read the two back and they were
    // identical, so a model that obeys its switch was described as one that
    // cannot be switched at all.
    const cat = await buildModelCatalog();
    const m3 = cat.models.find((m) => m.id === "M3");
    const undeclared = cat.models.find((m) => m.id === "undeclared");

    expect(m3?.thinkingSwitchSupported).not.toBe(undeclared?.thinkingSwitchSupported);
    expect(undeclared?.thinkingSwitchSupported).toBeNull();
    expect(thinkingShape(undeclared!)).toBe("undeclared");
  });

  it("does not claim a switch for the model nobody described one for", async () => {
    // The other half of the same fix. Defaulting the absent field to `true` at
    // the read would make every undeclared model on a deployment claim to
    // support a switch, which is a claim made on the vendor's behalf.
    const cat = await buildModelCatalog();
    const undeclared = cat.models.find((m) => m.id === "undeclared");
    expect(undeclared?.thinkingSwitchSupported).toBeNull();
    expect(undeclared?.reasoningEffortSupported).toBeNull();
  });

  it("and keeps a declared no from being filled back in", async () => {
    // M2.7 declared `false` on both. A default applied on read would report it
    // as supported, which is the claim that gets the control greyed wrongly in
    // the other direction — a vendor that refuses the switch being told it
    // accepts one.
    const cat = await buildModelCatalog();
    const m27 = cat.models.find((m) => m.id === "M2.7");
    expect(m27?.thinkingSwitchSupported).toBe(false);
    expect(m27?.reasoningEffortSupported).toBe(false);
  });

  it("and a model with levels still reports them, switch or not", async () => {
    // MiniMax-M3.1: five levels, and no switch. The levels survive the round
    // trip and the shape stays "levels", because a list is the vendor's own
    // words and outranks anything inferred about it.
    await createProvider({
      name: "MiniMax 3.1",
      kind: "openai",
      apiKey: "sk-b",
      baseUrl: "https://api.minimax.cn/v1",
      modelMapping: { "M3.1": "M3.1" },
      modelConfigs: {
        "M3.1": {
          upstreamId: "M3.1-Flash-Preview",
          clientId: "M3.1",
          contextLength: 1_000_000,
          maxOutputTokens: 131_072,
          reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
          thinkingSwitchSupported: false,
          inputCost: 0,
          outputCost: 0,
          enabled: true,
        },
      },
      enabled: true,
    });

    const cat = await buildModelCatalog();
    const m31 = cat.models.find((m) => m.id === "M3.1");
    expect(m31?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(m31?.thinkingSwitchSupported).toBe(false);
    expect(thinkingShape(m31!)).toBe("levels");
  });
});
