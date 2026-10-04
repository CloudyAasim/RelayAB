/**
 * The proposal tool advertised `reasoningLevels` as an array of strings while
 * its executor ran the value through a numeric coercion.
 *
 * `Number(["low", "high"])` is NaN, so every attempt to set a model's thinking
 * levels came back "thinking levels must be a non-negative number" — the field
 * was offered in the schema, described in the prompt, and carried all the way
 * through to the database, and could not be written by the one thing that
 * offers it. Every check that existed was on the *advertised* schema, which was
 * correct throughout; nothing asked the executor.
 *
 * These tests therefore call the executor's own function, not its declaration.
 */
import { describe, expect, it } from "vitest";
import { buildModelConfigPatch, toolDefinitions } from "@/lib/assistant/tools";
import { ModelConfigPatchSchema } from "@/lib/db/types";

/** The patch, or a thrown assertion when the tool refused. */
function patchOf(args: Record<string, unknown>): Record<string, unknown> {
  const built = buildModelConfigPatch(args);
  if ("error" in built) {
    throw new Error(`the tool refused the proposal: ${built.error}`);
  }
  return built.patch;
}

describe("the proposal tool can set thinking levels", () => {
  it("takes a list of words", () => {
    expect(patchOf({ reasoningLevels: ["low", "medium", "high"] })).toEqual({
      reasoningLevels: ["low", "medium", "high"],
    });
  });

  it("takes the five levels MiniMax actually publishes", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    expect(patchOf({ reasoningLevels: levels }).reasoningLevels).toEqual(levels);
  });

  it("takes an empty list, which is how a model stops offering any", () => {
    // A real answer for a model that does not think, and the only way to
    // withdraw levels a vendor has taken away.
    expect(patchOf({ reasoningLevels: [] })).toEqual({ reasoningLevels: [] });
  });

  it("trims them", () => {
    expect(patchOf({ reasoningLevels: [" low ", "high"] }).reasoningLevels).toEqual([
      "low",
      "high",
    ]);
  });

  it("says something useful when handed a number instead", () => {
    const built = buildModelConfigPatch({ reasoningLevels: "high" });
    expect("error" in built).toBe(true);
    if (!("error" in built)) return;
    // The old message was the number complaint, which is what made this a
    // mystery: the model had sent a list and been told to send a number.
    expect(built.error).toContain("字符串数组");
    expect(built.error).not.toContain("非负数字");
  });

  it("refuses a list with something that is not a word in it", () => {
    expect("error" in buildModelConfigPatch({ reasoningLevels: ["low", 3] })).toBe(
      true,
    );
    expect("error" in buildModelConfigPatch({ reasoningLevels: ["low", ""] })).toBe(
      true,
    );
  });

  it("refuses a list longer than the schema allows", () => {
    const tooMany = Array.from({ length: 25 }, (_, i) => `level-${i}`);
    expect("error" in buildModelConfigPatch({ reasoningLevels: tooMany })).toBe(true);
  });

  it("carries the levels beside the numbers, in one proposal", () => {
    // The case this was really blocking: an operator setting the window, the cap
    // and the levels together.
    expect(
      patchOf({
        contextLength: 204_800,
        maxOutputTokens: 32_768,
        inputCost: 1,
        outputCost: 8,
        reasoningLevels: ["low", "high"],
      }),
    ).toEqual({
      contextLength: 204_800,
      maxOutputTokens: 32_768,
      inputCost: 1,
      outputCost: 8,
      reasoningLevels: ["low", "high"],
    });
  });

  it("hands the apply path something it will accept", () => {
    // The two halves of the proposal, checked against each other with a value.
    const advertised = toolDefinitions(true).find(
      (t) => t.function.name === "propose_model_config_update",
    );
    const properties = (
      advertised?.function.parameters.properties as
        | Record<string, { type?: string }>
        | undefined
    ) ?? {};
    expect(properties.reasoningLevels?.type).toBe("array");

    const patch = patchOf({ reasoningLevels: ["low", "high"] });
    const parsed = ModelConfigPatchSchema.safeParse({
      upstreamId: "MiniMax-M3.1-Flash-Preview",
      clientId: "m3.1-flash",
      ...patch,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reasoningLevels).toEqual(["low", "high"]);
  });

  it("still refuses the things it always refused", () => {
    // Extracted rather than incidental: pulling the levels out of the numeric
    // loop must not have loosened it for everything else.
    expect("error" in buildModelConfigPatch({ inputCost: -1 })).toBe(true);
    expect("error" in buildModelConfigPatch({ contextLength: 1.5 })).toBe(true);
    expect("error" in buildModelConfigPatch({})).toBe(true);
    // Prices are the two that may carry a fraction.
    expect(patchOf({ inputCost: 0.5, outputCost: 0.5 })).toEqual({
      inputCost: 0.5,
      outputCost: 0.5,
    });
  });
});
