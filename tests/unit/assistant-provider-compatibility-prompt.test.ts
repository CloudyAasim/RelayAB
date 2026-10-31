/**
 * tests/unit/assistant-provider-compatibility-prompt.test.ts
 *
 * Configuring a provider was being done one field at a time, with no principle.
 *
 * The administrator asked for a provider's free models to be added. The result
 * came out with one protocol face open, no thought declarations, and parameter
 * rules the assistant had to think about rather than a rule it followed — and
 * every one of those decisions is invisible afterwards: the row says "enabled",
 * the model page shows a greyed-out control, a parameter a client sends is
 * dropped without a word. A configuration that quietly covers half the shapes a
 * provider can speak looks exactly like one that covers all of them.
 *
 * So the principle is written into the prompt as a rule with reasons, not left
 * to be re-derived per provider: take every client shape the upstream actually
 * offers, and forward every custom form the upstream actually accepts.
 *
 * Asserted on the prompt text rather than on behaviour, because the failure this
 * prevents is the assistant reasoning its way to a defensible-but-half answer
 * every time — which no fixture of a particular provider would catch. The
 * existing generic-prompt guard owns the two rules a new section must not
 * break: no model ids anywhere, and no vendor names in the thinking section.
 */
import { describe, it, expect } from "vitest";

import { ADMIN_SYSTEM_PROMPT } from "@/lib/assistant/prompts";

/** The compatibility section, by its heading. */
function section(): string {
  const from = ADMIN_SYSTEM_PROMPT.indexOf("## 二、配一个服务商的兼容性原则");
  expect(from, "the compatibility section is gone").toBeGreaterThan(-1);
  const to = ADMIN_SYSTEM_PROMPT.indexOf("## 三、关于变更", from);
  expect(to, "the compatibility section ran into the next one").toBeGreaterThan(from);
  return ADMIN_SYSTEM_PROMPT.slice(from, to);
}

describe("the prompt states the compatibility principle", () => {
  it("and says what it is, in both halves", () => {
    // The user's own phrasing, and the reason it is two halves rather than a
    // preference: neither half can be traded for the other, because what is lost
    // is a client that gets a 404 and a parameter that disappears.
    const text = section();
    expect(text).toMatch(/接住所有客户端形状/);
    expect(text).toMatch(/上游有的东西原样送到/);
    expect(text).toMatch(/不是.{0,30}取舍|可以同时成立/);
  });

  it("says how each client interface reaches the vendor", () => {
    // The route table replaced the two protocol faces: one row per client
    // interface, three answers each. The prompt has to teach that — the
    // assistant's tools still submit in the old vocabulary and the gateway
    // folds it into the table, so the model has to know that is what it is
    // doing when it changes one of those values.
    const text = section();
    expect(text).toContain("原样透传");
    expect(text).toContain("路由到");
    expect(text).toContain("不支持");
    // The four client interfaces it is about.
    for (const path of [
      "/v1/chat/completions",
      "/v1/responses",
      "/anthropic/v1/messages",
      "generateContent",
    ]) {
      expect(text, path).toContain(path);
    }
    // And the reason one interface being off is not a small thing: the other
    // half of the clients get a 404, and the interface list does not show it.
    expect(text).toMatch(/只开一个接口.{0,20}404/);
  });

  it("picks the answer by what the upstream has, not by preference", () => {
    // "Passed through" when the upstream publishes that protocol itself, "routed
    // to" it when it does not — and the reason, which is what a routed request
    // loses on the way through the hub.
    const text = section();
    expect(text).toMatch(/上游自己(就)?提供/);
    expect(text).toMatch(/枢纽/);
    // The old vocabulary is named as the old vocabulary, so the assistant does
    // not read it as the answer — it is the table's summary now.
    expect(text).toMatch(/旧的说法/);
    expect(text).toMatch(/摘要/);
    // And changing one of those values is changing the routing, which is the
    // sentence that keeps the assistant honest about what it is doing.
    expect(text).toMatch(/改这几个值等于改路由/);
  });

  it("passes vendor-specific parameters through by default", () => {
    const text = section();
    expect(text).toContain("textSpecs");
    expect(text).toMatch(/默认.{0,10}passthrough/);
    // `drop` must be the exception, and the reason has to say what the cost is —
    // a silent no-op the user finds in production.
    expect(text).toMatch(/drop.{0,40}例外/);
    expect(text).toMatch(/静默结果|不会出现在任何界面上/);
  });

  it("declares the upstream's thinking capabilities rather than leaving them blank", () => {
    const text = section();
    expect(text).toContain("reasoningLevels");
    expect(text).toContain("reasoningEffortSupported");
    expect(text).toContain("thinkingSwitchSupported");
    // Undeclared is not the same as dropped, and that is the link back to the
    // section above it — without it the greyed-out control has no explanation.
    expect(text).toMatch(/不填.{0,20}置灰|没声明/);
  });

  it("says a tradeoff has to be spoken out loud", () => {
    // Otherwise "compatibility" becomes "open everything", which produces a
    // provider with faces that 404 forever and looks configured.
    const text = section();
    expect(text).toMatch(/代价/);
    expect(text).toMatch(/打开能打开的/);
  });
});

describe("the section keeps the rules the other guards own", () => {
  it("names no model id", () => {
    // Duplicated deliberately: `assistant-prompt-stays-generic` asserts this over
    // the whole prompt, and this section is the one most likely to grow a
    // helpful-sounding example the next time somebody edits it.
    const hit = section().match(/\bM[123](\.\d+)?\b|speech-[\d.]+|image-0\d|asr-\d|whisper-\d|claude-|gpt-\d/i);
    expect(hit, `the section names a model: ${hit?.[0]}`).toBeNull();
  });

  it("and sits before the change-proposal rules, not inside them", () => {
    // The order is the argument: what to aim for, then how to propose it. A
    // section inserted after the proposal rules would be read as advice for
    // answering rather than for configuring.
    const compat = ADMIN_SYSTEM_PROMPT.indexOf("## 二、配一个服务商的兼容性原则");
    const propose = ADMIN_SYSTEM_PROMPT.indexOf("## 三、关于变更");
    expect(compat).toBeGreaterThan(-1);
    expect(propose).toBeGreaterThan(compat);
  });
});