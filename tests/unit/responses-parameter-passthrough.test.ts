/**
 * tests/unit/responses-parameter-passthrough.test.ts
 *
 * The Responses surface must not lose the client's parameters.
 *
 * The converter used to build the upstream body from a fixed list of fields it
 * recognised. Everything else a Responses client sent was **silently dropped** —
 * `reasoning.effort` above all, so a client asking for high reasoning got the
 * model's default with no error and nothing to notice. That is the bug this
 * file exists to prevent coming back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { responsesToChatRequest } from "@/lib/proxy/openai";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "proxy", "openai.ts"), "utf-8");

const convert = (req: Record<string, unknown>) =>
  responsesToChatRequest({ model: "m", input: "hi", ...req } as never) as Record<string, unknown>;

describe("a client's parameters reach the upstream", () => {
  it("the reasoning level, which is the one that was being thrown away", () => {
    // Responses nests it; Chat Completions takes it flat. Before, `reasoning` was
    // on a whitelist that did not include it, so the vendor never saw it.
    const out = convert({ reasoning: { effort: "high" } });
    expect(out.reasoning_effort).toBe("high");
    // And the nested spelling must not also go upstream: the two surfaces do not
    // agree on the name, and sending both is a 400.
    expect(out.reasoning).toBeUndefined();
  });

  it.each(["low", "medium", "high"])("%s survives the conversion", (effort) => {
    expect(convert({ reasoning: { effort } }).reasoning_effort).toBe(effort);
  });

  it("and it is absent when the client did not ask", () => {
    expect(convert({}).reasoning_effort).toBeUndefined();
    // A malformed value is not forwarded as garbage either.
    expect(convert({ reasoning: { effort: 7 } }).reasoning_effort).toBeUndefined();
    expect(convert({ reasoning: "high" }).reasoning_effort).toBeUndefined();
  });

  it.each([
    ["seed", 42],
    ["top_logprobs", 5],
    ["metadata", { tenant: "a" }],
    ["user", "client-1"],
    ["presence_penalty", 0.2],
    ["frequency_penalty", 0.3],
    ["n", 2],
    ["logit_bias", { "1": 2 }],
  ])("%s is forwarded rather than dropped", (field, value) => {
    expect(convert({ [field]: value })[field]).toEqual(value);
  });

  it("the ordinary sampling parameters still get through", () => {
    const out = convert({ temperature: 0.3, top_p: 0.8, stop: ["\n\n"] });
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.8);
    expect(out.stop).toEqual(["\n\n"]);
  });

  it("and an undefined value is not turned into a null the vendor has to read", () => {
    expect("temperature" in convert({ temperature: undefined })).toBe(false);
  });
});

describe("but the fields that would confuse an upstream are still gone", () => {
  it.each([
    "input",
    "instructions",
    "include",
    "previous_response_id",
    "store",
    "truncation",
    "prompt_cache_key",
    "text",
    "max_tool_calls",
  ])("%s is Responses-only and is not forwarded", (field) => {
    const out = convert({ [field]: "x" });
    expect(out[field], `${field} reached a Chat Completions upstream`).toBeUndefined();
  });

  it("the token cap is written once, in the spelling the upstream understands", () => {
    const out = convert({ max_output_tokens: 999 });
    expect(out.max_tokens).toBe(999);
    // Two spellings of one number is how you get an unexplainable 400.
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("and a client that used the Chat spelling already is honoured", () => {
    expect(convert({ max_tokens: 555 }).max_tokens).toBe(555);
  });
});

describe("the fix is structural, not a longer list", () => {
  it("the converter is a denylist, so an unrecognised parameter passes by default", () => {
    // A whitelist means a new OpenAI parameter is dropped until somebody
    // remembers it. The next release of the SDK will ship parameters nobody here
    // has heard of, and the relay should not be the thing that eats them.
    expect(SOURCE).toMatch(/const RESPONSES_ONLY_FIELDS/);
    expect(SOURCE).toMatch(/for \(const \[key, value\] of Object\.entries\(req as Record<string, unknown>\)\)/);
  });
});
