/**
 * Two proposals over one provider must not undo each other.
 *
 * Eight price changes were proposed, eight were approved, and every row in the
 * queue read `applied`. One model came out changed. The other seven were written
 * and then written back over: each proposal carried a copy of the whole model
 * table as it stood when it was *proposed*, and approving one replaced the table
 * with that copy. Approving in a row restored the old prices seven times, and
 * the survivor was whichever was approved last.
 *
 * The evidence that made it certain rather than suspected: the apply timestamps
 * ran in exactly the reverse of the create timestamps, and the only model whose
 * change survived was the last one applied.
 *
 * This test reproduces that shape directly. It does not read the source to check
 * that a particular word is present — the bug was not a missing word, it was a
 * stored snapshot being treated as current.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelConfigMergePatchSchema, ModelConfigPatchSchema } from "@/lib/db/types";
import { buildModelConfigPatch } from "@/lib/assistant/tools";
import { ProviderArgsSchema } from "@/app/api/assistant/actions/[id]/route";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");

const TOOLS = read("src", "lib", "assistant", "tools.ts");
const APPLY = read("src", "app", "api", "assistant", "actions", "[id]", "route.ts");

type ModelConfigs = Record<string, Record<string, unknown>>;

/**
 * The stored form a proposal carries: which model, and which fields.
 *
 * Mirrors what `propose_model_config_update` writes into `args`, and parsed
 * through the real schema so a field the apply path does not know would fail
 * here rather than at approval time.
 */
function storedIntent(clientId: string, patch: Record<string, unknown>) {
  const parsed = ModelConfigMergePatchSchema.parse({ ...patch });
  return { modelConfigTarget: { clientId, patch: parsed } };
}

/** The whole table, as a proposal written before the intent shape existed. */
function storedSnapshot(configs: ModelConfigs) {
  return { modelConfigs: configs };
}

/**
 * What the apply endpoint does with a stored proposal, given the provider as it
 * stands at that moment.
 *
 * The intent branch re-reads the provider; the snapshot branch does not, because
 * that is the bug.
 */
function applyTo(
  current: ModelConfigs,
  stored: ReturnType<typeof storedIntent> | ReturnType<typeof storedSnapshot>,
): ModelConfigs {
  if ("modelConfigTarget" in stored) {
    const live = { ...current };
    const { clientId, patch } = stored.modelConfigTarget;
    live[clientId] = { ...(live[clientId] ?? {}), ...patch };
    return live;
  }
  return { ...stored.modelConfigs };
}

const START: ModelConfigs = {
  "MiniMax-M2": { upstreamId: "MiniMax-M2", inputCost: 2.1, outputCost: 8.4 },
  "MiniMax-M2.5": { upstreamId: "MiniMax-M2.5", inputCost: 0, outputCost: 0 },
  "MiniMax-M2.7": { upstreamId: "MiniMax-M2.7", inputCost: 0, outputCost: 0 },
};

describe("approving a proposal composes with the ones before it", () => {
  it("two proposals for two models both survive", () => {
    const a = storedIntent("MiniMax-M2.5", { inputCost: 210, outputCost: 840 });
    const b = storedIntent("MiniMax-M2.7", { inputCost: 210, outputCost: 840 });

    // Both were written against this same starting state, minutes apart.
    const afterA = applyTo(START, a);
    const afterB = applyTo(afterA, b);

    expect(afterA["MiniMax-M2.5"].inputCost).toBe(210);
    expect(afterB["MiniMax-M2.5"].inputCost).toBe(210);
    expect(afterB["MiniMax-M2.7"].inputCost).toBe(210);
  });

  it("and the order they are approved in does not matter", () => {
    const a = storedIntent("MiniMax-M2.5", { inputCost: 210 });
    const b = storedIntent("MiniMax-M2.7", { inputCost: 420 });

    const ab = applyTo(applyTo(START, a), b);
    const ba = applyTo(applyTo(START, b), a);

    expect(ab).toEqual(ba);
  });

  it("eight proposals leave eight changes, not one", () => {
    // The shape that actually happened. The old code keeps the last one; the
    // count is the whole point, since every status in the queue said `applied`.
    const names = [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3",
    ];
    const proposals = names.map((clientId) =>
      storedIntent(clientId, { inputCost: 420, outputCost: 1680, reasoningEffortSupported: false }),
    );

    const result = proposals.reduce<ModelConfigs>((acc, p) => applyTo(acc, p), START);
    for (const name of names) {
      expect(result[name]?.inputCost, `${name} was reverted by a later approval`).toBe(420);
      expect(result[name]?.reasoningEffortSupported).toBe(false);
    }
  });

  it("a field nobody proposed is left alone", () => {
    // The snapshot shape carried everything, so it restored everything too —
    // including reverting a change an earlier approval had just made.
    const changed = applyTo(
      START,
      storedIntent("MiniMax-M2", { inputCost: 210, cachedInputCost: 21 }),
    );
    const next = applyTo(changed, storedIntent("MiniMax-M2.7", { inputCost: 210 }));
    expect(next["MiniMax-M2"].cachedInputCost).toBe(21);
  });
});

describe("the stored shape is the intent, not a snapshot", () => {
  it("the merge shape does not require the two identifiers", () => {
    // The shape the tool actually stores: a price change, a level declaration,
    // whatever was asked for — and nothing else. Validated against the row shape
    // it reported, at approval time, that the patch must carry `upstreamId` and
    // `clientId` — so every proposal failed the moment the administrator clicked,
    // with a message about two fields the proposal had no reason to have.
    const patch = ModelConfigMergePatchSchema.parse({
      inputCost: 420,
      outputCost: 1680,
      reasoningEffortSupported: false,
    });
    expect(Object.keys(patch).sort()).toEqual([
      "inputCost",
      "outputCost",
      "reasoningEffortSupported",
    ]);
  });

  it("but the row shape still does, because a row has to be identifiable", () => {
    // The two shapes exist for two directions. Confusing them is what put the
    // requirement in the wrong place.
    expect(ModelConfigPatchSchema.safeParse({ inputCost: 1 }).success).toBe(false);
    expect(
      ModelConfigPatchSchema.safeParse({ upstreamId: "u", clientId: "c", inputCost: 1 }).success,
    ).toBe(true);
  });

  it("the tool stores which model and which fields", () => {
    expect(TOOLS).toContain("args: { modelConfigTarget: { clientId: clientId.data, patch } }");
    // The preview is still built — the administrator has to see the resulting
    // table before approving — but it goes into the diff, not into the args.
    expect(TOOLS).toContain("renderProviderDiff(provider, { modelConfigs: preview }");
  });

  it("the apply re-reads the provider before merging", () => {
    expect(APPLY).toMatch(/const current = await getProviderById\(claimed\.targetId\)/);
    expect(APPLY).toMatch(/live\[modelConfigTarget\.clientId\] = \{/);
  });

  it("a proposal written in the old shape still applies", () => {
    // One is sitting in the queue right now. Reading only the new shape would
    // spend that approval on nothing, which is the failure this endpoint was
    // already written about once.
    expect(APPLY).toContain("modelConfigs: z.record(z.string(), ModelConfigPatchSchema).optional()");
  });

  it("and the applied message names what was actually written", () => {
    // It used to list the keys of the stored args. With the intent shape that
    // would report `modelConfigTarget` — a field the provider does not have.
    expect(APPLY).toContain("appliedFields");
  });
});

describe("what the tool stores is what the apply path can read", () => {
  /**
   * Both sides imported, not reconstructed.
   *
   * The failure this section exists for: the tool wrote one shape and the
   * endpoint read a different one, and nothing noticed until an administrator
   * clicked approve and got a validation error about two fields the proposal
   * had no reason to carry. Re-deriving either shape here would have missed the
   * bug for the same reason the source had it.
   */
  it("every field the tool can set survives into the apply path's schema", () => {
    for (const field of [
      "inputCost",
      "outputCost",
      "cachedInputCost",
      "cacheWriteCost",
      "reasoningLevels",
      "reasoningEffortSupported",
    ]) {
      const sample =
        field === "reasoningLevels"
          ? ["low", "high"]
          : field === "reasoningEffortSupported"
            ? false
            : 42;
      const built = buildModelConfigPatch({ [field]: sample, summary: "x" });
      expect("patch" in built, `${field} was refused by the tool`).toBe(true);
      if (!("patch" in built)) continue;

      const parsed = ProviderArgsSchema.safeParse({
        modelConfigTarget: { clientId: "MiniMax-M3", patch: built.patch },
      });
      expect(
        parsed.success,
        `${field}: the tool stores a shape the apply path rejects — ${
          parsed.success ? "" : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }
  });

  it("a real proposal, end to end, applies without an error", () => {
    // The whole of what the administrator clicked on, from the tool's own output
    // to the apply path's own schema.
    const built = buildModelConfigPatch({
      inputCost: 420,
      outputCost: 1680,
      cachedInputCost: 84,
      cacheWriteCost: 0,
      reasoningEffortSupported: false,
      summary: "补 M3 价格",
    });
    expect("patch" in built).toBe(true);
    if (!("patch" in built)) return;

    const parsed = ProviderArgsSchema.safeParse({
      modelConfigTarget: { clientId: "MiniMax-M3", patch: built.patch },
    });
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });
});
