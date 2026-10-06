/**
 * tests/unit/assistant-prompt-credential-path.test.ts
 *
 * The assistant answered "how long did that take?" with a confident mechanism,
 * and the mechanism was wrong in three parts: the account path does go through
 * this gateway's providers, it does record usage, and the empty list it saw was
 * empty for a different reason than the one it gave.
 *
 * The shape of the mistake is the general one: an empty result was read as an
 * explanation, and the answer built on it sounded authoritative because nothing
 * in it hedged. So the guards here are not "the prompt mentions credentials" —
 * it already did, and the error happened anyway. They pin the two claims that
 * were false, and the habit that replaces inferring them.
 */
import { describe, expect, it } from "vitest";

import { USER_SYSTEM_PROMPT, ADMIN_SYSTEM_PROMPT } from "@/lib/assistant/prompts";

/**
 * The user prompt, and only the user prompt.
 *
 * Which credential a call goes out with is the caller's business, so this lives
 * in the user half and not in `SHARED`. Asserting it on both would have been a
 * test that invites the section to be copied into the admin half, where it would
 * then be maintained in two places and eventually disagree with itself.
 */
const PROMPTS = { user: USER_SYSTEM_PROMPT };

describe("the prompt says the account path is not outside the gateway", () => {
  it("says both credentials reach the same providers and the same accounting", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not put both paths on one route`).toMatch(
        /同一(套|条|个).*(服务商|代理|协议|映射)|同一个(函数|代理)/,
      );
      expect(prompt, `${name} prompt does not say the account path is recorded`).toMatch(
        /计入配额|用量记录|计费/,
      );
    }
  });

  it("names the account path as being inside, not outside", () => {
    // The exact sentence that was wrong. "不在网关外面" has to be stated, because
    // the wrong version is not a wording slip — it is what the model reached for
    // when asked where its own traffic went.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not rule out the outside-the-gateway claim`).toMatch(
        /不是.{0,12}在网关(外面|之外)|同样计入|不经过网关.{0,6}(错|不对)/,
      );
    }
  });
});

describe("the prompt refuses to infer a mechanism from an empty result", () => {
  it("says an empty field is a result, not a cause", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not separate result from cause`).toMatch(
        /是.{0,8}结果.{0,12}不是.{0,8}(原因|机制)|结果.{0,8}不是.{0,8}原因/,
      );
    }
  });

  it("uses the key-scoped list as the worked example, since that is the trap", () => {
    // `get_my_usage` lists recent requests by the user's API keys. The account
    // path has no key, so it cannot appear there — which looks like proof it was
    // never recorded. Naming this case is worth more than the general rule,
    // because the general rule is the one a model will agree with and then not
    // apply.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt does not name the key-scoped list`).toContain(
        "recentRequests",
      );
      expect(prompt, `${name} prompt does not say "not recorded"`).toMatch(
        /不是因为它没被记录|不是因为.{0,10}没被记录/,
      );
    }
  });

  it("and names a general habit to fall back on", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} prompt has no fallback when a field cannot explain itself`).toMatch(
        /读不到就说读不到|先确认自己站在哪里|先怀疑口径/,
      );
    }
  });
});

describe("what must not come back", () => {
  /**
   * Collected as a list and compared to empty, rather than matched and asserted
   * on the first hit. `expect(firstMatch?.[0]).toBeUndefined()` reports "expected
   * '不经过本部署的服务商' to be undefined", which names the violation and
   * nothing about where it came from.
   */
  const find = (source: string, re: RegExp): string[] =>
    [...source.matchAll(re)].map((m) => m[0]);

  it("no claim that a path skips the gateway", () => {
    // Guards against a well-meaning summary losing the negation and keeping the
    // claim, which is the version that is actually false.
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      // The 的 matters: the claim was actually written as 「不经过本部署的服务商」,
      // and a pattern that insists on 「本部署」 abutting 「服务商」 misses the
      // sentence it was written to catch.
      const hits = find(
        prompt,
        /不经过(本部署|这个网关|网关)?的?服务商|在网关(外面|之外)运行/g,
      );
      expect(hits, `${name} prompt still claims a path skips the gateway`).toEqual([]);
    }
  });

  it("no model or vendor name — the prompt is deployment-wide", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      const hits = find(
        prompt,
        /\bM[123](\.\d+)?\b|speech-[\d.]+|image-0\d|asr-\d|whisper-\d|claude-|gpt-\d|MiniMax/gi,
      );
      expect(hits, `${name} prompt names a model or vendor`).toEqual([]);
    }
  });

  it("and the older rules are still intact", () => {
    expect(USER_SYSTEM_PROMPT).toContain("没有真正测过就不要说测过了");
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt, `${name} lost the declared-not-probed rule`).toMatch(
        /永远是声明的，不是检测出来的/,
      );
    }
  });

  it("and the whole thing stays in the user half, not copied into the admin half", () => {
    // Deliberately not in `SHARED`: the admin configures providers, the caller
    // chooses which credential to spend. If this ever belongs in both, that is a
    // decision to make on purpose — not something a copy-paste should do.
    expect(ADMIN_SYSTEM_PROMPT).not.toContain("recentRequests");
    expect(ADMIN_SYSTEM_PROMPT).not.toContain("用我的账号身份");
  });
});
