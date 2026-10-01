/**
 * tests/unit/assistant-diff.test.ts
 *
 * The diff is the safety mechanism. An admin approves a change by reading it,
 * so a diff that overstates what will happen is worse than no diff at all —
 * it trains the reader to skim.
 *
 * Live evidence of the bug this pins: a patch containing only
 * `anthropicEnabled: false` rendered as
 *
 *     baseUrl
 *       - https://api.minimaxi.com/v1
 *       + (未设置)
 *
 * i.e. it claimed the change would wipe the base URL. It would not — the
 * update path merges `patch.baseUrl ?? existing.baseUrl` — but the reviewer
 * had no way to know that from the card in front of them.
 */
import { describe, it, expect } from "vitest";
import { renderProviderDiff, renderMediaDiff } from "@/lib/assistant/diff";
import type { Provider } from "@/lib/db/types";
import type { MediaProvider } from "@/lib/media/spec";

const provider = {
  id: "p1",
  name: "MiniMax",
  kind: "openai",
  baseUrl: "https://api.minimaxi.com/v1",
  encryptedApiKey: "encrypted",
  modelMapping: { "MiniMax-M2": "MiniMax-M2" },
  modelConfigs: {},
  enabled: true,
  priority: 0,
  headers: {},
  upstreamFormat: "responses",
  openaiEnabled: true,
  anthropicEnabled: true,
  anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as Provider;

describe("renderProviderDiff", () => {
  it("shows only the fields the patch actually names", () => {
    const diff = renderProviderDiff(provider, { anthropicEnabled: false }, "关掉 Anthropic 面");

    expect(diff).toContain("anthropicEnabled");
    expect(diff).toContain("- true");
    expect(diff).toContain("+ false");

    // None of these are in the patch, so none may appear at all.
    expect(diff).not.toContain("baseUrl");
    expect(diff).not.toContain("openaiEnabled");
    expect(diff).not.toContain("priority");
    expect(diff).not.toContain("(未设置)");
  });

  it("includes the summary the operator supplied", () => {
    const diff = renderProviderDiff(provider, { enabled: false }, "临时停用 MiniMax");
    expect(diff).toContain("临时停用 MiniMax");
    expect(diff).not.toContain("(未填写)");
  });

  it("does render a field the patch clears on purpose", () => {
    // Explicitly nulling a field IS a change, and must still be visible.
    const diff = renderProviderDiff(provider, { anthropicBaseUrl: null }, "清掉 Anthropic 基址");
    expect(diff).toContain("anthropicBaseUrl");
    expect(diff).toContain("https://api.minimaxi.com/anthropic");
  });

  it("reports added and removed models separately", () => {
    const diff = renderProviderDiff(
      provider,
      { modelMapping: { "MiniMax-M2": "MiniMax-M2", "MiniMax-M3": "MiniMax-M3" } },
      "补上 M3",
    );
    expect(diff).toContain("新增 MiniMax-M3");
    expect(diff).not.toContain("移除");
  });

  it("surfaces a context-window change, which is the one that breaks silently", () => {
    const diff = renderProviderDiff(
      provider,
      {
        modelMapping: { "MiniMax-M2": "MiniMax-M2" },
        modelConfigs: {
          "MiniMax-M2": {
            upstreamId: "MiniMax-M2",
            clientId: "MiniMax-M2",
            contextLength: 204_800,
            maxOutputTokens: 131_072,
          },
        },
      },
      "修正上下文窗口",
    );
    expect(diff).toContain("上下文窗口");
    expect(diff).toContain("204,800");
  });

  it("states that keys are untouched", () => {
    const diff = renderProviderDiff(provider, { enabled: false }, "x");
    expect(diff).toContain("不会触碰加密密钥");
  });
});

describe("renderMediaDiff", () => {
  const media = {
    id: "m1",
    name: "MiniMax Media",
    baseUrl: "https://api.minimaxi.com",
    encryptedApiKey: "encrypted",
    enabled: true,
    priority: 1,
    models: { "image-01": { upstreamId: "image-01" } },
    specs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as MediaProvider;

  it("shows only the fields the patch names", () => {
    const diff = renderMediaDiff(media, { enabled: false }, "临时停用媒体");
    expect(diff).toContain("enabled");
    expect(diff).toContain("临时停用媒体");
    expect(diff).not.toContain("baseUrl");
    expect(diff).not.toContain("priority");
  });

  it("does not claim models were removed when only specs are replaced", () => {
    const diff = renderMediaDiff(
      media,
      { specs: [{ capability: "image.generate", transport: { method: "POST", path: "/v1/image_generation" } }] },
      "换 spec",
    );
    expect(diff).toContain("image.generate");
    expect(diff).not.toContain("移除");
  });
});
