/**
 * The thinking switch has to be findable, and the advice about it has to be true.
 *
 * Two things went missing, in opposite directions:
 *
 *  - The parameter that *is* the switch — MiniMax takes `thinking.type`, not
 *    `reasoning_effort` — was not declared in the chat preset. Undeclared
 *    parameters pass through, so nothing was broken; but the spec exists so the
 *    background page can show an operator what a protocol accepts, and a switch
 *    nobody can see is a switch nobody finds. The same argument applies to
 *    `output_config`, which is where a vendor puts thinking depth on its
 *    Anthropic surface, and to `reasoning_split`, which moves the thinking
 *    content and so decides whether a reader looking at the separated field
 *    sees any.
 *
 *  - The assistant was told the levels are declared from the vendor's
 *    documentation, and nothing else. So "turn thinking off" had exactly one
 *    thing it could do — clear the list — which changes our own dropdown and
 *    the request not at all. Worse, leaving the setting alone is not a neutral
 *    act: for one of these models the untouched default is its most expensive
 *    level, and for the other it means thinking stays on.
 *
 * The preset checks parse the shipped presets rather than reading their source,
 * so a rule that is only described in a comment cannot satisfy them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIGURABLE_PROTOCOLS,
  TEXT_PROTOCOL_PRESETS,
  protocolPreset,
} from "@/lib/protocol/text-protocols";
import { parseTextSpec } from "@/lib/protocol/text-spec";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

/** The declared parameters of a preset, as the background page would list them. */
function declared(protocol: keyof typeof TEXT_PROTOCOL_PRESETS): string[] {
  return Object.keys(TEXT_PROTOCOL_PRESETS[protocol].parameters ?? {});
}

describe("the thinking switch is declared where a client can find it", () => {
  it("the chat preset names `thinking`, not only `reasoning_effort`", () => {
    // The two are different questions. One vendor's `reasoning_effort` tunes
    // depth; another's switch is `thinking.type` and cannot be reached by
    // sending an effort at all. A preset that names only the first tells an
    // operator the wrong thing is missing.
    expect(declared("openai-chat")).toContain("thinking");
  });

  it("and names where the thinking content goes", () => {
    // A client that reads only the separated field concludes a thinking model is
    // not thinking. That is a false negative about the vendor, produced by
    // where we put its output, and the parameter that decides it should be
    // visible next to the one that decides whether it thinks.
    expect(declared("openai-chat")).toContain("reasoning_split");
  });

  it("the Anthropic preset names `output_config`", () => {
    // On this surface the depth is not `reasoning_effort` at all. A spec that
    // forwards `reasoning_effort` to a vendor that has never heard of it looks
    // configured and changes nothing.
    expect(declared("anthropic-messages")).toContain("output_config");
  });

  it("every configurable preset still parses", () => {
    // The declarations above are only worth anything if the documents they went
    // into are ones an operator can actually store.
    for (const protocol of CONFIGURABLE_PROTOCOLS) {
      const parsed = parseTextSpec(protocolPreset(protocol));
      expect(parsed.ok, `${protocol}: ${parsed.ok ? "" : parsed.errors.join("; ")}`).toBe(true);
    }
  });

  it("and a preset handed out for editing is a copy, not the original", () => {
    // The editor mutates what it is given. A preset that could be mutated would
    // change the next operator's starting point.
    const a = protocolPreset("openai-chat");
    const b = protocolPreset("openai-chat");
    a.parameters!.thinking = { mode: "drop" };
    expect(b.parameters!.thinking).toEqual({ mode: "passthrough" });
  });
});

describe("the assistant is told the truth about turning thinking off", () => {
  const PROMPTS = read("src", "lib", "assistant", "prompts.ts");

  it("told that a level and a switch are different things", () => {
    // Without this the only move available for "turn thinking off" is clearing
    // reasoningLevels, which edits our dropdown and not the request.
    expect(PROMPTS).toContain("思考的「开关」和「档位」是两件事");
  });

  it("told that leaving the setting alone is not a neutral act", () => {
    // The default is the vendor's, and for one of these models that is the
    // deepest and priciest level. Saying nothing about it is how a user picks
    // "default" expecting to spend less and spends more.
    expect(PROMPTS).toContain("「不填」不是「关」");
  });

  it("given the field name for each protocol, which differ", () => {
    // Same question, three spellings. An assistant that has only learned one
    // writes a spec that forwards a parameter the upstream has never seen.
    for (const field of ["reasoning_effort", "output_config", "thinking"]) {
      expect(PROMPTS, `${field} is not mentioned in the prompt`).toContain(field);
    }
    expect(PROMPTS).toContain("output_config.effort");
  });

  it("told that whether thinking can be turned off depends on the model", () => {
    // One of these models answers a request to disable with a 400. Presenting
    // "off" as a capability of the vendor rather than of the model is how the
    // assistant invents a switch that does not exist.
    expect(PROMPTS).toContain("M3.1-Flash-Preview");
    expect(PROMPTS).toContain("能不能关");
  });

  it("and pointed at the tool that answers what a protocol declares", () => {
    expect(PROMPTS).toContain("list_text_protocols");
  });
});

describe("a bulk configuration job is two stores, not one", () => {
  const PROMPTS = read("src", "lib", "assistant", "prompts.ts");

  it("says the configuration and the document are different places", () => {
    // The failure this replaces: a handsome parameter table in the docs, and a
    // provider row whose prices are still empty. Both look finished, the second
    // one was never written, and the user finds out when a model bills at zero.
    expect(PROMPTS).toContain("两个地方");
    expect(PROMPTS).toContain("只写文档等于配置一个字都没改");
  });

  it("names both stores, so one request is not one call", () => {
    expect(PROMPTS).toContain("list_providers");
    expect(PROMPTS).toContain("propose_model_config_update");
    expect(PROMPTS).toContain("propose_doc_pages");
  });

  it("says to work from the full model list rather than the models in view", () => {
    // A job phrased as "fill in what is missing" reads as a one-off, and one-off
    // work touches the model that was in the conversation. The list is the
    // work list.
    expect(PROMPTS).toContain("完整模型清单");
  });

  it("and to report what was skipped instead of dropping it", () => {
    // Silence is indistinguishable from done. Nine models and eight proposals
    // is the shape of the failure.
    expect(PROMPTS).toContain("回报一张表");
    expect(PROMPTS).toContain("跳过");
  });

  it("forbids filling a number in rather than looking it up", () => {
    // A wrong unit price is silent forever: nothing errors, and nothing reports
    // that it is wrong. The only defence is refusing to guess.
    //
    // Anchored on the words, not the sentence: the prompt is hard-wrapped, so
    // any phrase long enough to be readable is a phrase that a reflow will
    // split across a newline, and the assertion would fail on a reformat.
    expect(PROMPTS).toContain("数字不许编");
    expect(PROMPTS).toContain("查不到");
  });

  it("forbids adding models to a job that was about filling in", () => {
    // The request said "完善配置", not "add models" — and the media endpoints
    // this deployment does not serve are the ones that would be added.
    expect(PROMPTS).toContain("补全 ≠ 新增");
    expect(PROMPTS).toContain("不要加视频和音乐模型");
  });

  it("points at the tool table for these two jobs", () => {
    expect(PROMPTS).toContain("改某个模型的上下文");
    expect(PROMPTS).toContain("改参数指南");
  });
});

describe("the settings form does not let 'default' stand for 'off'", () => {
  const DICT = read("src", "lib", "i18n", "dict.ts");
  const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");

  it("labels the empty option as what it is", () => {
    // "Off" would be a lie: the option sends nothing, and nothing is the
    // vendor's choice, which for some models is thinking at its deepest.
    expect(DICT).toContain('"assistant.settings.reasoningOff": "默认（不发送）"');
    expect(DICT).toContain('"assistant.settings.reasoningOff": "Default (not sent)"');
  });

  it("says so on the screen, next to the field", () => {
    // In the dictionary and nowhere else is a string nobody reads. The claim is
    // about what happens when the user does nothing, so it belongs where the
    // option they are about to pick is.
    expect(PANEL).toContain("reasoningDefaultIsNotOff");
  });
});
