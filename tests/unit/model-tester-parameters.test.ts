/**
 * tests/unit/model-tester-parameters.test.ts
 *
 * The model tester can now send request parameters, and reports what the
 * operator's protocol did to them.
 *
 * The second half is the point. A tester that silently receives a different
 * answer from the one it asked for is indistinguishable from a broken model,
 * and the operator has no way to tell the two apart. So the decisions are
 * computed by the same helper the proxy uses, and shown — if they disagreed, it
 * would be a lie printed next to the answer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyParameterPolicy } from "@/lib/protocol/parameter-policy";

const ROOT = process.cwd();
const TESTER = readFileSync(join(ROOT, "src", "app", "(user)", "dashboard", "models", "ModelTester.tsx"), "utf-8");
const ROUTE = readFileSync(join(ROOT, "src", "app", "api", "assistant", "test-model", "route.ts"), "utf-8");
const PAGE = readFileSync(join(ROOT, "src", "app", "(user)", "dashboard", "models", "page.tsx"), "utf-8");

describe("the tester can send parameters", () => {
  it("the four that are numbers everywhere are coerced, because a string is a 400", () => {
    // `"temperature": "0.5"` reads as a broken model to whoever is testing.
    expect(TESTER).toMatch(/const NUMERIC = new Set\(\["temperature", "top_p", "max_tokens", "seed"\]\)/);
    expect(TESTER).toMatch(/Number\.isFinite\(Number\(trimmed\)\) \? Number\(trimmed\) : trimmed/);
  });

  it("and anything else goes in verbatim, because only the sender knows its type", () => {
    expect(TESTER).toMatch(/Object\.assign\(value, parsed as Record<string, unknown>\)/);
  });

  it("a malformed extra-parameter box is refused before the call, not after", () => {
    expect(TESTER).toMatch(/if \(!built\.ok\) \{[\s\S]*?setExtraError\(built\.message\)/);
    expect(TESTER).toMatch(/if \(!res\.ok \|\| !json\?\.ok\)/);
  });

  it("both credential paths send them, not just the account one", () => {
    // The key path posts to the public route itself; leaving the parameters off
    // there would mean the two halves of the page test different things.
    expect(TESTER).toMatch(/parameters: built\.value/);
    expect(TESTER).toMatch(/\.\.\.built\.value,\n\s+model,/);
  });
});

describe("and it reports what the protocol did to them", () => {
  it("from the same helper the proxy uses, so the two cannot disagree", () => {
    expect(ROUTE).toMatch(/import \{ applyParameterPolicy \} from "@\/lib\/protocol\/parameter-policy"/);
    // The same lookup the proxy does, *for the same surface*. The test goes out
    // through Chat Completions, so it is the `openai-chat` rule and no other:
    // `readTextSpec` folded a list down to whichever entry came first, which on
    // a provider serving both surfaces is the wrong one — the tester reported
    // drops and clamps that had not happened.
    expect(ROUTE).toMatch(
      /import \{ readTextSpecs, specForSurface \} from "@\/lib\/protocol\/text-specs"/,
    );
    expect(ROUTE).toMatch(/specForSurface\(readTextSpecs\(provider\), "openai-chat"\)/);
    // Not a re-implementation: the answer must come from the real thing.
    expect(ROUTE).not.toMatch(/function .*[Pp]olicy\s*\(/);
  });

  it("and says which interface's rule it is reporting", () => {
    // A provider carries one rule per interface. Without the label, the lines
    // in the panel belong to nobody and a tester cannot act on them.
    expect(ROUTE).toMatch(/governedBy/);
  });

  it("picks a provider that can actually answer this call", () => {
    // The test goes out through `proxyChatCompletion`, so it needs an
    // OpenAI-facing provider. It used to take `findProvidersForModel(...)[0]`,
    // which is any provider mapping the model — including one that only has
    // its Anthropic side on. The panel would then explain the request with that
    // provider's `openai-chat` rule, and the call would fail for a reason the
    // panel had just contradicted.
    //
    // The selection is what matters here. The unfiltered lookup still appears
    // once, in the branch that names the providers so the refusal can list them.
    expect(ROUTE).toMatch(/const openai = await findOpenAIProvidersForModel\(model\);/);
    expect(ROUTE).toMatch(/const provider = openai\[0\];/);
    expect(ROUTE).not.toMatch(/const provider = providers\[0\];/);
    // And the two helpers that already existed for exactly this question.
    const db = readFileSync(join(ROOT, "src", "lib", "db", "providers.ts"), "utf-8");
    expect(db).toMatch(/export async function findOpenAIProvidersForModel/);
    expect(db).toMatch(/export async function findAnthropicProvidersForModel/);
  });

  it("refuses up front, naming the providers that do map the model", () => {
    // A 409 with the reason, rather than a call that fails upstream with the
    // panel's explanation already printed above it.
    expect(ROUTE).toMatch(/explained\.unavailable/);
    expect(ROUTE).toMatch(/code: "no_openai_provider"/);
    expect(ROUTE).toMatch(/anthropic_only/);
  });

  it("looked up on the same provider the request will be routed to", () => {
    // The routing question is "which provider serves this call", and for an
    // OpenAI-shaped call that is the OpenAI-facing list — not the list of
    // everyone who maps the model. See the guard above for what the wrong
    // version looked like.
    expect(ROUTE).toMatch(/findOpenAIProvidersForModel\(model\)[\s\S]*?openai\[0\]/);
  });

  it("and the three views of it — asked, sent, decided — all come back", () => {
    expect(ROUTE).toMatch(/parametersAsked: asked/);
    expect(ROUTE).toMatch(/parametersSent: explained\.applied/);
    expect(ROUTE).toMatch(/parameterDecisions: explained\.decisions/);
  });

  it("the page renders them rather than logging them into the void", () => {
    expect(TESTER).toMatch(/setDecisions\(json\.data\?\.parameterDecisions \?\? \[\]\)/);
    expect(TESTER).toMatch(/\{decisions\.length > 0 && \(/);
  });

  it("with a word for each outcome, in both languages", () => {
    for (const action of ["kept", "dropped", "defaulted", "forced", "clamped", "renamed"]) {
      expect(PAGE, `${action} has no label`).toContain(`action.${action}`);
    }
  });
});

describe("the report is true", () => {
  it("an override is reported as an override", () => {
    // The whole feature. If this says "forwarded as sent" while the protocol
    // replaced the value, the operator reads a lie next to their own answer.
    const asked = { reasoning_effort: "low" };
    const { body, decisions } = applyParameterPolicy(asked, {
      parameters: { reasoning_effort: { mode: "force", value: "high" } },
    });
    expect(body.reasoning_effort).toBe("high");
    expect(asked.reasoning_effort).toBe("low");
    expect(decisions.find((d) => d.name === "reasoning_effort")?.action).toBe("forced");
  });

  it("and a parameter nobody named is not reported as touched", () => {
    const { decisions } = applyParameterPolicy({ seed: 1 }, { parameters: { top_p: { mode: "drop" } } });
    expect(decisions.find((d) => d.name === "seed")).toBeUndefined();
  });
});
