/**
 * tests/unit/detect-levels.test.ts
 *
 * The detector, against refusals vendors have actually produced.
 *
 * The last version of this feature was reported working and detected nothing:
 * it read a model list, which does not carry levels, and fell back to four
 * names it invented. So this is checked against *recorded vendor answers* —
 * strings shaped like the ones upstreams return — rather than against the
 * source, and the cases are the ones that decide whether it works.
 */
import { describe, it, expect } from "vitest";
import {
  PROBE_SENTINEL,
  candidatesFor,
  decideLevels,
  isRefusal,
  levelsFromRefusal,
  refusalVocabulary,
} from "@/lib/assistant/detect-levels";

describe("reading a vendor's vocabulary out of a refusal", () => {
  it("takes the names out of the shapes upstreams use", () => {
    expect(levelsFromRefusal("`reasoning_effort` must be one of 'low', 'high'")).toEqual([
      "low",
      "high",
    ]);
    expect(levelsFromRefusal('invalid value: "x", expected one of: minimal | medium | high')).toEqual(
      ["minimal", "medium", "high"],
    );
    expect(levelsFromRefusal('{"error":{"enum":["think_low","think_high"]}}')).toEqual([
      "think_low",
      "think_high",
    ]);
  });

  it("and does not read English prose as a vocabulary", () => {
    // The failure that would put words in a model's mouth: a refusal that
    // happens to quote the parameter name, the field, or the word "invalid",
    // coming back as a one-item vocabulary that then overwrites a good one.
    const noisy =
      "The parameter reasoning_effort is invalid. Unsupported value: expected a string for the field effort.";
    const found = levelsFromRefusal(noisy);
    expect(found, `prose leaked in: ${found.join(", ")}`).not.toContain("reasoning_effort");
    expect(found).not.toContain("invalid");
    expect(found).not.toContain("Unsupported");
    expect(found).not.toContain("parameter");
    expect(found).not.toContain("field");
    expect(found).not.toContain("effort");
  });

  it("and knows the difference between naming none and naming nothing", () => {
    // The distinction the whole feature turns on: no vocabulary in the refusal
    // means go and probe each candidate; a refusal naming none is itself the
    // answer.
    expect(refusalVocabulary("rate limit exceeded")).toBeNull();
    expect(refusalVocabulary("must be one of 'low', 'high'")).toEqual(["low", "high"]);
  });
});

describe("what to try", () => {
  it("the sentinel first, then whatever the refusal named, then the fallback", () => {
    const order = candidatesFor({ declared: [], fromRefusal: ["max", "high"], fallback: ["low"] });
    expect(order[0]).toBe(PROBE_SENTINEL);
    expect(order).toContain("max");
    expect(order).toContain("high");
    expect(order).toContain("low");
  });

  it("and the operator's own list outranks anything guessed", () => {
    const order = candidatesFor({ declared: ["think_low"], fromRefusal: null, fallback: ["minimal"] });
    expect(order.indexOf("think_low")).toBeLessThan(order.indexOf("minimal"));
  });

  it("without probing forever", () => {
    const many = Array.from({ length: 40 }, (_, i) => `level-${i}`);
    // Twelve candidates plus the one sentinel, because every one of them is a
    // real request against a real quota and the point of the cap is to bound
    // that, not to look tidy.
    expect(candidatesFor({ declared: many, fromRefusal: null, fallback: [] })).toHaveLength(13);
  });
});

describe("telling a refusal from a failure to answer", () => {
  it("a 4xx from a working upstream is a refusal", () => {
    expect(isRefusal(400, "invalid value")).toBe(true);
    expect(isRefusal(422, "unrecognized")).toBe(true);
  });

  it("a rate limit is not — the vendor declined to answer, not the value", () => {
    // Treating this as a refusal would delete a level the model takes, on the
    // evidence that the vendor was busy.
    expect(isRefusal(429, "slow down")).toBe(false);
  });

  it("neither is a 5xx, a timeout, or an empty body", () => {
    expect(isRefusal(500, "internal")).toBe(false);
    expect(isRefusal(502, "")).toBe(false);
    expect(isRefusal(undefined, undefined)).toBe(false);
  });
});

describe("what gets stored", () => {
  it("only what the vendor accepted, in the order tried", () => {
    const probes = [
      { level: PROBE_SENTINEL, accepted: false, status: 400, error: "must be one of 'low','high'" },
      { level: "low", accepted: true, status: 200 },
      { level: "high", accepted: true, status: 200 },
      { level: "minimal", accepted: false, status: 400, error: "invalid value" },
    ];
    expect(decideLevels(probes)).toEqual(["low", "high"]);
  });

  it("and an empty result is a real answer, not a reason to keep the old list", () => {
    // A model that takes none of them is a fact about the model. Keeping the
    // previous list because the new run found nothing is how a stale answer
    // outlives the model that gave it.
    expect(
      decideLevels([
        { level: "low", accepted: false, status: 400, error: "invalid" },
        { level: "high", accepted: false, status: 400, error: "invalid" },
      ]),
    ).toEqual([]);
  });

  it("and a run that could not answer changes nothing", () => {
    // Nothing was learned, so nothing is written. Every probe "failed" only in
    // the sense that the vendor was unavailable.
    const probes = [
      { level: "low", accepted: false, status: 503, error: "upstream down" },
      { level: "high", accepted: false, status: 429, error: "slow down" },
    ];
    expect(decideLevels(probes)).toEqual([]);
  });
});

/**
 * The real answer, from the real vendor.
 *
 * Recorded by sending an invalid `reasoning_effort` at MiniMax through this
 * deployment, after the proxy was fixed to stop discarding the upstream's body:
 *
 *   Upstream 400: invalid params, invalid reasoning_effort:
 *   "__relayab_not_a_level__" (allowed: low, medium, high, xhigh, max) (2013)
 *
 * Two things this caught that nothing else did. There is no `minimal` — the
 * level this system had been offering does not exist for this model. And the
 * shape is a parenthesised comma-separated run with no quotes, no brackets and
 * no pipe, which every "obvious" parser skips: the detector reported the
 * vocabulary it had *guessed*, having read nothing.
 */
describe("the real answer, from the real vendor", () => {
  const REAL =
    'invalid params, invalid reasoning_effort: "__relayab_not_a_level__" (allowed: low, medium, high, xhigh, max) (2013)';

  it("is read, in full, and the rejected value is not in it", () => {
    expect(refusalVocabulary(REAL)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // The value that was sent is the one thing that must never come back as a
    // level of the model.
    expect(levelsFromRefusal(REAL)).not.toContain(PROBE_SENTINEL);
  });

  it("and it corrects what the presets claimed", () => {
    // The presets were `minimal` first. This model does not take it, and the
    // vendor said so in the first refusal anyone actually read.
    expect(levelsFromRefusal(REAL)).not.toContain("minimal");
    expect(levelsFromRefusal(REAL)).toContain("xhigh");
    expect(levelsFromRefusal(REAL)).toContain("max");
  });

  it("and the sentinel still leads, so this costs one request", () => {
    const candidates = candidatesFor({
      declared: [],
      fromRefusal: refusalVocabulary(REAL),
      fallback: [],
    });
    expect(candidates[0]).toBe(PROBE_SENTINEL);
    expect(candidates.slice(1)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
