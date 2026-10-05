/**
 * The checks are only worth having if they fire on what actually happened.
 *
 * Every case below is a configuration that existed on this deployment, or a
 * shape the assistant produced while working on it. They all parse, all store,
 * and all bill — which is the problem: nothing about them is a schema error, so
 * the write succeeds and the wrong number quietly becomes the price.
 *
 * The last group is the other half: a configuration that is unusual but
 * correct, which must come back clean. An audit that flags everything is an
 * audit nobody reads.
 */
import { describe, expect, it } from "vitest";
import { auditModelConfigs, describeFindings } from "@/lib/providers/config-audit";

/** The four models that were billing nothing. */
const FREE_MODELS = {
  "MiniMax-M2.5": { upstreamId: "MiniMax-M2.5", inputCost: 0, outputCost: 0, enabled: true },
  "MiniMax-M2.5-highspeed": {
    upstreamId: "MiniMax-M2.5-highspeed",
    inputCost: 0,
    outputCost: 0,
    enabled: true,
  },
  "MiniMax-M2.7": { upstreamId: "MiniMax-M2.7", inputCost: 0, outputCost: 0, enabled: true },
  "MiniMax-M2.7-highspeed": {
    upstreamId: "MiniMax-M2.7-highspeed",
    inputCost: 0,
    outputCost: 0,
    enabled: true,
  },
};

const GOOD = {
  "MiniMax-M2": {
    upstreamId: "MiniMax-M2",
    inputCost: 210,
    outputCost: 840,
    cachedInputCost: 21,
    cacheWriteCost: 262.5,
    enabled: true,
  },
  "MiniMax-M3": {
    upstreamId: "MiniMax-M3",
    inputCost: 420,
    outputCost: 1680,
    cachedInputCost: 84,
    cacheWriteCost: 0,
    enabled: true,
  },
};

describe("the audit catches the configurations that were wrong", () => {
  it("models that bill nothing", () => {
    const found = auditModelConfigs({ ...GOOD, ...FREE_MODELS });
    const zero = found.filter((f) => f.code === "all_zero");
    expect(zero).toHaveLength(4);
    for (const f of zero) expect(f.blocking).toBe(true);
  });

  it("and that finding blocks the write rather than warning about it", () => {
    // A warning is read after the administrator approves. This is the one that
    // has to be asked about first.
    const free = auditModelConfigs(FREE_MODELS);
    expect(free.every((f) => f.blocking)).toBe(true);
  });

  it("yuan written into a column that holds credits", () => {
    // MiniMax-M2 was 2.1 / 8.4 — the yuan price, a hundredth of the credits
    // every other row used. Plausible on its face; a hundred times wrong.
    const found = auditModelConfigs({ ...GOOD, "MiniMax-M2": { inputCost: 2.1, outputCost: 8.4 } });
    const units = found.filter((f) => f.code === "unit_mismatch");
    expect(units).toHaveLength(1);
    expect(units[0].clientId).toBe("MiniMax-M2");
    expect(units[0].message).toContain("100");
  });

  it("a cache read price with no write price", () => {
    // The fallback is the input price, so an unset write is a silent charge for
    // something the vendor gives away. It warns rather than blocks: free and
    // unset are genuinely different and the vendor is the one who knows.
    const found = auditModelConfigs({
      m: { inputCost: 420, outputCost: 1680, cachedInputCost: 42 },
    });
    const unset = found.filter((f) => f.code === "cache_write_unset");
    expect(unset).toHaveLength(1);
    expect(unset[0].blocking).toBe(false);
    expect(unset[0].message).toContain("显式填 0");
  });

  it("a write price that looks like a different field's value", () => {
    const found = auditModelConfigs({
      m: { inputCost: 210, outputCost: 840, cacheWriteCost: 5000 },
    });
    expect(found.some((f) => f.code === "write_gt_input")).toBe(true);
  });
});

describe("and leaves correct configurations alone", () => {
  it("the rates as they are configured now", () => {
    expect(auditModelConfigs(GOOD)).toEqual([]);
  });

  it("including a zero write price, which is a real answer", () => {
    // The one place zero is correct: M3 and M3.1 are charged nothing for a
    // write. A check that treated 0 as "missing" would push the operator to
    // set the input price there instead.
    const found = auditModelConfigs({
      m: { inputCost: 420, outputCost: 1680, cachedInputCost: 84, cacheWriteCost: 0 },
    });
    expect(found).toEqual([]);
  });

  it("a deliberately free model, once it says so", () => {
    const found = auditModelConfigs({
      m: { inputCost: 0, outputCost: 0, enabled: false },
    });
    expect(found).toEqual([]);
  });

  it("a write price of 1.25× the input, which is what MiniMax charges", () => {
    expect(
      auditModelConfigs({ m: { inputCost: 210, outputCost: 840, cacheWriteCost: 262.5 } }),
    ).toEqual([]);
  });
});

describe("the findings read as questions, not as verdicts", () => {
  it("each one says what it is and what the default would be", () => {
    const lines = describeFindings(auditModelConfigs(FREE_MODELS));
    expect(lines).toHaveLength(4);
    // Not `lines[0]`: the order is the order of the object, and asserting on
    // the first one would pass for a set that names a different model.
    for (const line of lines) {
      // Parse the id out of the line rather than searching for it. A substring
      // search picks `MiniMax-M2.5` when the line is about
      // `MiniMax-M2.5-highspeed`, which is a shorter list of models than the
      // one being described — the exact mistake this file exists to catch.
      const parsed = line.match(/^\[all_zero\] (.+)：/);
      expect(parsed, `cannot read a model out of: ${line}`).not.toBeNull();
      expect(Object.keys(FREE_MODELS)).toContain(parsed![1]);
      expect(line).toContain("完全不计费");
    }
    // Every model that is actually free is named, not a sample of them.
    const named = lines.join("\n");
    for (const id of Object.keys(FREE_MODELS)) {
      expect(named).toContain(id);
    }
  });
});
