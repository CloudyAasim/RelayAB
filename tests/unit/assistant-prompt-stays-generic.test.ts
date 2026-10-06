/**
 * tests/unit/assistant-prompt-stays-generic.test.ts
 *
 * The system prompt is deployment-wide, and the facts that change per model are
 * not.
 *
 * A fix once wrote "M2.x ignores the switch, M3 has no levels, M3.1 has five"
 * into the prompt. Every one of those was true, on the day, of the models this
 * deployment happened to be configured with — and all three would have been
 * wrong the moment an operator added a model from anywhere else. The prompt
 * shapes every turn on every deployment; a vendor's current line-up is data,
 * and data belongs in the model configuration where `list_providers` reads it.
 *
 * So this file has two jobs: the two thinking flags have to be explained, and no
 * specific model may be named as though it were a rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT } from "@/lib/assistant/prompts";

const PROMPTS = { user: USER_SYSTEM_PROMPT, admin: ADMIN_SYSTEM_PROMPT };

describe("the prompt explains the two thinking flags as axes, not answers", () => {
  it("names both fields, so a model with no levels has somewhere to put the fact", () => {
    // Without these the model sees only `reasoningLevels`, reads "leave it empty
    // when the docs are silent", and stops — which is how a model that refuses
    // to be switched off ended up described as one that had simply declared no
    // levels.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt never names reasoningEffortSupported`).toContain(
        "reasoningEffortSupported",
      );
      expect(prompt, `${name} prompt never names thinkingSwitchSupported`).toContain(
        "thinkingSwitchSupported",
      );
    }
  });

  it("says an empty list is not the same as not supporting thinking", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not separate empty from unsupported`).toMatch(
        /空.{0,20}不等于|不等于.{0,20}不支持思考|只是.{0,20}没有公布/,
      );
    }
  });

  it("says the two fail independently, and that one is not the other", () => {
    // This is the pair of states the display has to tell apart, stated as a
    // property of the schema rather than as a fact about a vendor.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not say they fail separately`).toMatch(
        /各自|会.*失败|不是同一件事/,
      );
    }
  });

  it("says an undeclared field is not a declared no", () => {
    // The distinction the whole grey-out design rests on, and the one an eager
    // assistant erases by filling in a field it did not check.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not protect an undeclared field`).toMatch(
        /没查过|没声明|不要顺手/,
      );
    }
  });

  it("points at the configuration rather than at recall", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not send the model to the config`).toContain(
        "list_providers",
      );
    }
  });
});

describe("the prompt names no model as though it were a rule", () => {
  /**
   * A model id, anywhere.
   *
   * This is the one that cannot be defended. "OpenAI 兼容的 /v1/*" is a *shape* —
   * it describes this deployment's own API surface, it is true of every model on
   * every provider, and the section built around it ("厂商文档不是我们的文档")
   * is entirely about shapes. A model id is not: it is one row in one operator's
   * configuration table, and it goes stale the moment they add a row.
   */
  const MODEL_ID = /\bM[123](\.\d+)?\b|speech-[\d.]+|image-0\d|asr-\d|whisper-\d|claude-|gpt-\d/i;

  it("names no model id, in either prompt", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      const hit = prompt.match(MODEL_ID);
      expect(hit, `${name} prompt names a model: ${hit?.[0]}`).toBeNull();
    }
  });

  it("names no vendor in the section that explains the thinking flags", () => {
    // Scoped, not global, and deliberately so. A vendor's *behaviour* is the
    // thing that must not be generalised — that is where "M2.x ignores the
    // switch" would have gone, and it would have been true on the day and wrong
    // the next deployment. Anywhere else in the prompt, a vendor name is either
    // naming a protocol shape or naming this deployment's own surface, both of
    // which are the product rather than the configuration.
    const from = ADMIN_SYSTEM_PROMPT.indexOf("## 空数组不说明任何事");
    expect(from, "the thinking-flags section is gone").toBeGreaterThan(-1);
    const to = ADMIN_SYSTEM_PROMPT.indexOf("## 厂商文档不是我们的文档", from);
    expect(to, "the thinking-flags section ran into the next one").toBeGreaterThan(from);
    const section = ADMIN_SYSTEM_PROMPT.slice(from, to);

    const hit = section.match(/MiniMax|OpenAI|Anthropic|智谱|Gemini|DeepSeek/i);
    expect(hit, `the thinking-flags section names a vendor: ${hit?.[0]}`).toBeNull();
  });

  it("and says so as a rule, so the next edit knows", () => {
    // Without this the rule above reads as a preference. The reason a future
    // edit would otherwise make is a good day — one model behaves unusually, the
    // assistant explains it, and the explanation gets promoted into the prompt
    // because that is the only place anyone was writing.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not mark model facts as data`).toMatch(
        /是.{0,20}的(属性|配置)|不是.{0,20}通用|属于.{0,20}数据|以.*list_providers.*为准/,
      );
    }
  });
});

describe("what the prompt already had, and must not lose", () => {
  it("still keeps the levels list declared rather than probed", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt lost the declared-not-probed rule`).toMatch(
        /永远是声明的，不是检测出来的/,
      );
    }
  });

  it("still keeps the whole-replacement warning", () => {
    // The guard that pre-dates all of this, and the one with the most blood on
    // it. Adding a section next to it must not quietly soften it.
    expect(ADMIN_SYSTEM_PROMPT).toContain("整份替换");
  });
});

describe("the prompt file itself", () => {
  it("is the one that was edited", () => {
    // A guard that reads a copy is a guard that can pass while the shipped
    // prompt is untouched.
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "assistant", "prompts.ts"),
      "utf-8",
    );
    expect(source).toContain("thinkingSwitchSupported");
    expect(ADMIN_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
