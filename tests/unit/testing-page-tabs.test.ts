/**
 * tests/unit/testing-page-tabs.test.ts
 *
 * The test page is one card with three tabs, and its configuration control has
 * three named choices: 本账号 / 服务密钥 / 其他服务商.
 *
 * Before this, the page stacked three cards (chat, media, other provider), each
 * with its own key input; the "other provider" card was a fourth idea of what
 * the page was for. These guards keep the shape: one surface, tabs, and the
 * three names on the credential control.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { translate } from "@/lib/i18n/dict";

const SRC = join(process.cwd(), "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf-8");

const WORKSPACE = read("app", "(user)", "dashboard", "models", "ModelsWorkspace.tsx");
const PAGE = read("app", "(user)", "dashboard", "models", "page.tsx");
const CHAT = read("app", "(user)", "dashboard", "models", "ModelTester.tsx");
const MEDIA = read("app", "(user)", "dashboard", "models", "MediaTester.tsx");
const SEARCH = read("app", "(user)", "dashboard", "models", "SearchTester.tsx");
const PANEL = read("lib", "assistant", "CredentialPanel.tsx");
const PROBE = read("app", "(user)", "dashboard", "models", "CustomModelProbe.tsx");
const PAGE_SRC = read("app", "(user)", "dashboard", "models", "page.tsx");

describe("one testing surface, three tabs", () => {
  it("the tabs are 文本 / 媒体 / 搜索", () => {
    expect(translate("zh-CN", "dashboard.models.tabs.text")).toBe("文本");
    expect(translate("zh-CN", "dashboard.models.tabs.media")).toBe("媒体");
    expect(translate("zh-CN", "dashboard.models.tabs.search")).toBe("搜索");
    expect(WORKSPACE).toContain('role="tablist"');
    expect(WORKSPACE).toMatch(/label: tabLabels\.text/);
    expect(WORKSPACE).toMatch(/label: tabLabels\.media/);
    expect(WORKSPACE).toMatch(/label: tabLabels\.search/);
  });

  it("the search tab exists only when the page was given a search test", () => {
    // The route behind it is admin-only; a tab nobody can use is not rendered.
    expect(WORKSPACE).toMatch(/visible: Boolean\(searchTest\)/);
  });

  it("the testers are embedded, not cards inside a card", () => {
    expect(CHAT).toContain("embedded");
    expect(MEDIA).toContain("embedded");
    expect(WORKSPACE).toMatch(/<ModelTester\s+embedded/);
    expect(WORKSPACE).toMatch(/<MediaTester embedded/);
  });

  it("the other-provider form can actually be tested: address, key, model, prompt", () => {
    // Reported: selecting 其他服务商 showed only the three connection fields, so
    // there was no way to send anything of your own. The prompt is the test.
    expect(PROBE).toContain("labels.prompt");
    expect(PROBE).toContain("<textarea");
    expect(PROBE).toContain("prompt: prompt.trim()");
    expect(translate("zh-CN", "dashboard.models.custom.prompt")).toBe("测试内容");
    expect(PAGE_SRC).toContain('prompt: t("dashboard.models.custom.prompt")');
  });

  it("the other-provider form is the third configuration, not another card", () => {
    expect(CHAT).toContain("<CustomModelProbe");
    expect(CHAT).toContain("otherLabels");
    expect(CHAT).toMatch(/configMode === "other"/);
    // It is inside the tab's body, after the credential control.
    expect(CHAT.indexOf("<CredentialChoice")).toBeLessThan(CHAT.indexOf("<CustomModelProbe"));
  });
});

describe("the configuration choices are named once", () => {
  it("本账号 / 服务密钥 / 其他服务商", () => {
    expect(translate("zh-CN", "dashboard.models.config.account")).toBe("本账号");
    expect(translate("zh-CN", "dashboard.models.config.key")).toBe("服务密钥");
    expect(translate("zh-CN", "dashboard.models.config.other")).toBe("其他服务商");
  });

  it("the panel takes those names from the screen, keeping the assistant's own", () => {
    expect(PANEL).toContain("modeLabels");
    expect(PANEL).toContain("extraOption");
    expect(CHAT).toContain("modeLabels={labels.config ?");
    expect(CHAT).toContain("labels.config.other");
  });

  it("the media tab names them too, and offers the third option", () => {
    expect(MEDIA).toContain("modeLabels={{ account: labels.configAccount, key: labels.configKey }}");
    expect(MEDIA).toContain("extraOption");
    expect(MEDIA).toContain("<OtherMediaProbe");
  });

  it("the search tab can test a vendor instead of this deployment", () => {
    expect(SEARCH).toContain("OtherSearchProbe");
    expect(SEARCH).toContain("source === \"other\"");
  });

  it("every configuration shows the endpoint it will call", () => {
    expect(CHAT).toContain("labels.endpoint");
    expect(CHAT).toContain("/api/assistant/test-model");
    expect(MEDIA).toContain("labels.endpointLabel");
    expect(MEDIA).toContain("/api/assistant/test-media");
  });

  it("the other-provider text panel leads with thinking, folds sampling, streams", () => {
    for (const field of ["temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "seed", "stop"]) {
      expect(PROBE, `${field} is missing from the other-provider form`).toContain(`"${field}"`);
    }
    // The two thinking controls are the point; sampling is folded behind them.
    expect(PROBE).toContain("labels.reasoning");
    expect(PROBE).toContain("labels.thinkingMode");
    expect(PROBE).toContain("out.reasoning_effort = effort");
    expect(PROBE).toContain("out.thinking = { type: thinking }");
    expect(PROBE).toContain("/api/models/probe-chat");
    expect(PROBE).toContain("stream");
    expect(PROBE).toContain("labels.raw");
  });

  it("the gateway tester focuses the same way", () => {
    expect(CHAT).toContain("labels.reasoning");
    expect(CHAT).toContain("labels.thinkingMode");
    expect(CHAT).toContain("value.reasoning_effort = effort");
    expect(CHAT).toContain("value.thinking = { type: thinking }");
    expect(CHAT).toContain("labels.sampling");
  });

  it("the guided media form and the raw escape hatch both exist", () => {
    expect(MEDIA).toContain("OtherMediaProbe");
    expect(PROBE).toContain("RawRequestPanel");
    expect(read("app", "api", "models", "probe-media", "route.ts")).toContain(
      '"/images/generations"',
    );
    expect(read("app", "api", "models", "probe-raw", "route.ts")).toContain("/probe-raw");
    expect(read("app", "api", "models", "probe-search", "route.ts")).toContain("searxng");
  });
});
