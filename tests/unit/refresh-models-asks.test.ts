/**
 * tests/unit/refresh-models-asks.test.ts
 *
 * "已更新 0 个模型的配置。" — true, and useless.
 *
 * The button re-read each provider's model list and wrote back whatever the
 * vendor chose to publish there. MiniMax publishes no thinking levels in it and
 * barely a window either, so every model reported unchanged, every run, and the
 * one button whose name promised to update the configuration could not.
 *
 * The information lives in the vendor's reaction to a request, so the refresh
 * now asks. These pin that it does, and that it reports what it learned rather
 * than a count that can be zero for three entirely different reasons.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const ROUTE = read("src", "app", "api", "assistant", "refresh-models", "route.ts");
const PANEL = read("src", "app", "(user)", "dashboard", "assistant", "AssistantSettingsPanel.tsx");
const DICT = read("src", "lib", "i18n", "dict.ts");

describe("the refresh button", () => {
  it("asks the vendor, rather than only reading the list it already read", () => {
    // The list pass is kept — a window or a cap the vendor does publish is
    // still worth taking — but it cannot be the whole thing.
    expect(ROUTE, "the ask was dropped").toMatch(
      /async function askLevels\(/,
    );
    expect(ROUTE, "the sentinel is not sent").toContain("PROBE_SENTINEL");
    // The refusal is what carries the vocabulary, so it has to be read.
    expect(ROUTE, "the refusal is not parsed").toContain("refusalVocabulary");
    // One request per model, not twelve: a whole provider must not be able to
    // spend the quota on its own list.
    expect(ROUTE).toContain("max_tokens: 1");
    expect(ROUTE, "the number of asks is unbounded").toContain(
      "MAX_ASKS_PER_PROVIDER",
    );
  });

  it("writes what it learned, and leaves a silent vendor alone", () => {
    expect(ROUTE, "an answered vocabulary is not stored").toMatch(
      /configs\[clientId\] = \{ \.\.\.current, reasoningLevels: r\.levels \};/,
    );
    // Nothing said is not "no levels" — it is "nobody answered", and writing
    // that over a good list is how a declared configuration disappears.
    expect(ROUTE, "a vendor that said nothing is treated as an answer").toContain(
      "if (r.levels === null) continue;",
    );
  });

  it("is given time to answer, and a failure to answer is named as one", () => {
    // Not a timeout in the end: nine asks came back in seconds, which is a
    // connection-level failure, not a slow one. What the round established is
    // that the *distinction* has to survive to the screen, and that the cause
    // has to come with it — a timeout, a refused connection and a wrong URL all
    // arrive as the same empty outcome.
    expect(ROUTE, "the ask still uses the shared eight-second default").toMatch(
      /timeoutMs: ASK_TIMEOUT_MS/,
    );
    expect(ROUTE, "no ceiling is named").toContain("const ASK_TIMEOUT_MS");
    // And the outcome that means "we did not find out" is kept apart from the
    // one that means "the vendor declined to say" — and it carries why, because
    // a fast failure is a different bug from a slow one and neither is
    // fixable without knowing which.
    expect(ROUTE, "timeouts are not counted apart").toMatch(/unanswered \+= 1;/);
    expect(ROUTE, "a no-body result is still treated as a refusal").not.toMatch(
      /if \(!said\) return \{ levels: refusalVocabulary\(\"\)/,
    );
    expect(ROUTE).toMatch(/if \(!said\) \{/);
    expect(ROUTE, "the reason is not carried out").toContain(
      "reason: r.error ?? \"no response body\"",
    );
    expect(ROUTE, "reasons are not collected").toMatch(/reasons\.push\(/);
    expect(PANEL, "the panel cannot tell a timeout from a silence").toContain(
      "assistant.settings.refreshUnanswered",
    );
    expect(PANEL, "the panel does not show the cause").toContain("o.reasons ?? []");
    expect(DICT).toContain("assistant.settings.refreshUnanswered");
  });

  it("and reports what was asked, not only what changed", () => {
    // "Updated 0" is the same sentence for "asked nobody", "asked nine and
    // learned nothing", and "asked nine and learned nine". Only the first
    // number was shown.
    expect(ROUTE, "asks are not counted").toMatch(/asked \+= 1;/);
    expect(ROUTE, "learned levels are not counted").toMatch(/learned \+= 1;/);
    expect(PANEL, "the panel cannot tell an empty result from a silent vendor").toContain(
      "assistant.settings.refreshSilent",
    );
    expect(PANEL).toContain("assistant.settings.refreshLearned");
    expect(DICT).toContain("assistant.settings.refreshSilent");
    expect(DICT).toContain("assistant.settings.refreshLearned");
  });
});
