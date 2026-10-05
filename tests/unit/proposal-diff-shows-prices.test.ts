/**
 * A confirmation screen has to describe the change.
 *
 * Eight price proposals were submitted and approved on a screen whose model
 * section rendered the context window and nothing else. A proposal that
 * repriced a model produced a diff that did not contain the number it was
 * repricing to — the only mention of the price was whatever the model had
 * typed into the summary, which is the one line on the screen nobody can rely
 * on. A model that wrote a terse summary would have shown a diff describing no
 * change at all.
 *
 * These assertions read the rendered text, because the text is the product. The
 * old implementation passed every one of them except the one that matters, which
 * is the point: a guard that checks the function was called proves nothing about
 * what an operator was shown.
 */
import { describe, expect, it } from "vitest";
import { renderProviderDiff } from "@/lib/assistant/diff";
import type { Provider } from "@/lib/db/types";

function providerWith(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: "p1",
    name: "MiniMax",
    kind: "openai",
    baseUrl: "https://api.minimax.cn/v1",
    enabled: true,
    priority: 0,
    encryptedApiKey: "x",
    modelMapping: { m: "m" },
    modelConfigs: {
      m: {
        upstreamId: "m",
        clientId: "m",
        contextLength: 204800,
        maxOutputTokens: 131072,
        reasoningLevels: [],
        reasoningEffortSupported: true,
        inputCost: 0,
        outputCost: 0,
        enabled: true,
      },
    },
    upstreamFormat: "responses",
    openaiEnabled: true,
    anthropicEnabled: true,
    anthropicBaseUrl: null,
    headers: {},
    upstreamId: null,
    ...overrides,
  } as unknown as Provider;
}

describe("a price proposal's diff says what the prices become", () => {
  const diff = renderProviderDiff(
    providerWith(),
    {
      modelConfigs: {
        m: {
          upstreamId: "m",
          clientId: "m",
          contextLength: 204800,
          maxOutputTokens: 131072,
          reasoningLevels: [],
          reasoningEffortSupported: false,
          inputCost: 210,
          outputCost: 840,
          cachedInputCost: 21,
          cacheWriteCost: 262.5,
          enabled: true,
        },
      },
    },
    "",
  );

  it("names every rate that changes, with the number it becomes", () => {
    for (const [label, to] of [
      ["输入积分/百万 token", "210"],
      ["输出积分/百万 token", "840"],
      ["缓存读积分/百万 token", "21"],
      ["缓存写积分/百万 token", "262.5"],
    ]) {
      expect(diff, `${label} is not in the diff`).toContain(label);
      expect(diff, `${label} does not say it becomes ${to}`).toContain(`→ ${to}`);
    }
  });

  it("and says what each was before, so a zero price is visible as a zero", () => {
    // The failure this guards is a rate going from nothing to something, and a
    // diff that only printed the "after" would read as a rate being introduced
    // rather than a model that was billing nothing being repriced.
    expect(diff).toContain("0 → 210");
    expect(diff).toContain("0 → 840");
  });

  it("renders a boolean as a boolean, not as two identical words", () => {
    // It was `(未设置) → (未设置)` — the same text on both sides of an arrow,
    // which says the value did not change while showing that it did.
    expect(diff).toContain("支持思考等级：是 → 否");
    expect(diff).not.toMatch(/→\s*\(未设置\)\s*→\s*\(未设置\)/);
  });

  it("renders a level list as the list", () => {
    const withLevels = renderProviderDiff(
      providerWith(),
      {
        modelConfigs: {
          m: {
            upstreamId: "m",
            clientId: "m",
            contextLength: 204800,
            maxOutputTokens: 131072,
            reasoningLevels: ["low", "high"],
            inputCost: 0,
            outputCost: 0,
            enabled: true,
          },
        },
      },
      "",
    );
    expect(withLevels).toContain("low / high");
  });

  it("says nothing about a model whose entry is carried but not changed", () => {
    // Nine identical "unchanged" rows is how a real change gets lost in the list.
    const untouched = renderProviderDiff(
      providerWith(),
      {
        modelConfigs: {
          m: {
            upstreamId: "m",
            clientId: "m",
            contextLength: 204800,
            maxOutputTokens: 131072,
            reasoningLevels: [],
            reasoningEffortSupported: true,
            inputCost: 0,
            outputCost: 0,
            enabled: true,
          },
        },
      },
      "",
    );
    expect(untouched).not.toContain("模型配置：");
  });

  it("still describes the context-window collapse it was written for", () => {
    const shrunk = renderProviderDiff(
      providerWith(),
      {
        modelConfigs: {
          m: {
            upstreamId: "m",
            clientId: "m",
            contextLength: 4096,
            maxOutputTokens: 131072,
            inputCost: 0,
            outputCost: 0,
            enabled: true,
          },
        },
      },
      "",
    );
    expect(shrunk).toContain("上下文");
    expect(shrunk).toContain("204,800");
    expect(shrunk).toContain("4,096");
  });

  it("is not empty even when the summary is empty", () => {
    // The summary is written by the model. It cannot be the only place the price
    // appears, because a model that writes "done" would then produce a
    // confirmation document describing nothing.
    expect(diff.trim().length).toBeGreaterThan(0);
    expect(diff).toContain("210");
  });
});
