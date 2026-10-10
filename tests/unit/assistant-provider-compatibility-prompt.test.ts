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

  it("open both protocol faces when the upstream offers both", () => {
    const text = section();
    expect(text).toContain("openaiEnabled");
    expect(text).toContain("anthropicEnabled");
    expect(text).toContain("anthropicBaseUrl");
    // And the reason it is not optional, which is what stops it being read as
    // "usually fine either way".
    expect(text).toMatch(/只开一个面.{0,20}404/);
  });

  it("picks upstreamFormat by what the upstream has, not by preference", () => {
    // The trap the field exists for: setting `responses` does not convert a chat
    // request, it only changes where `/v1/responses` is forwarded to.
    const text = section();
    expect(text).toMatch(/upstreamFormat/);
    expect(text).toMatch(/实际提供/);
    expect(text).toMatch(/不做 chat→responses 转换/);
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