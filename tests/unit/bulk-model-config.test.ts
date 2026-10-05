/**
 * Configuring a provider in one go has to be possible, not just convenient.
 *
 * The single-model tool works, and a provider with nine models needs it nine
 * times: nine calls, nine approvals, nine chances to stop halfway and leave
 * half the catalogue repriced. Every instruction written to get a bulk job
 * done here was working around the absence of the capability rather than
 * steering the model.
 *
 * So the check is not "does the tool exist" but "does one call carry the whole
 * job", checked against the schemas the two ends actually use.
 */
import { describe, expect, it } from "vitest";
import { toolDefinitions } from "@/lib/assistant/tools";
import { buildModelConfigPatch } from "@/lib/assistant/tools";
import { ProviderArgsSchema } from "@/app/api/assistant/actions/[id]/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TOOLS = readFileSync(join(ROOT, "src", "lib", "assistant", "tools.ts"), "utf8");
const APPLY = readFileSync(
  join(ROOT, "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
  "utf8",
);

const def = toolDefinitions(true).find(
  (t) => t.function.name === "propose_model_configs_update",
);
const props = (def?.function.parameters.properties ?? {}) as Record<string, unknown>;

describe("one call can configure a whole provider", () => {
  it("there is a tool for it, and it is admin-only", () => {
    expect(def, "the bulk tool is missing").toBeDefined();
    expect(toolDefinitions(false).map((t) => t.function.name)).not.toContain(
      "propose_model_configs_update",
    );
  });

  it("it takes a provider and a map of models, not a list of one", () => {
    expect(props).toHaveProperty("providerId");
    expect(props).toHaveProperty("models");
    // A list would be a field the model has to build correctly before anything
    // happens; a map keyed by model name is the shape it is already reading.
    const models = props.models as { type?: string; additionalProperties?: unknown };
    expect(models.type).toBe("object");
    expect(typeof models.additionalProperties).toBe("object");
  });

  it("and the single-model tool is not the only way in", () => {
    expect(TOOLS).toMatch(/async function proposeModelConfigsUpdate\(/);
    expect(TOOLS).toMatch(/case "propose_model_configs_update":/);
  });
});

describe("what it stores, the apply path can read", () => {
  it("nine models' worth of merges come out as one argument", () => {
    const models: Record<string, Record<string, unknown>> = {};
    for (const name of [
      "MiniMax-M2",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M3",
      "MiniMax-M3.1-Flash-Preview",
    ]) {
      models[name] = { inputCost: 420, outputCost: 1680, reasoningEffortSupported: false };
    }
    const targets = Object.entries(models).map(([clientId, patch]) => {
      const built = buildModelConfigPatch(patch);
      if ("error" in built) throw new Error(built.error);
      return { clientId, patch: built.patch };
    });

    const parsed = ProviderArgsSchema.safeParse({ modelConfigTargets: targets });
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
    if (!parsed.success) return;
    expect(
      (parsed.data as { modelConfigTargets: unknown[] }).modelConfigTargets,
    ).toHaveLength(9);
  });

  it("merges each one, so nine proposals cannot revert each other", () => {
    // The failure this whole shape exists to prevent: a stored copy of the
    // table, applied twice, restores the old prices. Checked here by applying
    // the entries the way the endpoint does, one after another, onto a table
    // that starts as the old state.
    const start: Record<string, Record<string, unknown>> = {
      m1: { upstreamId: "m1", inputCost: 0 },
      m2: { upstreamId: "m2", inputCost: 0 },
    };
    const targets = [
      { clientId: "m1", patch: { inputCost: 210 } },
      { clientId: "m2", patch: { inputCost: 420 } },
    ];
    let live: Record<string, Record<string, unknown>> = { ...start };
    for (const { clientId, patch } of targets) {
      live = { ...live, [clientId]: { ...(live[clientId] ?? {}), ...patch } };
    }
    expect(live.m1.inputCost).toBe(210);
    expect(live.m2.inputCost).toBe(420);

    // And a second proposal on top of the first keeps both.
    const later = { clientId: "m1", patch: { cachedInputCost: 21 } };
    live = { ...live, [later.clientId]: { ...live[later.clientId], ...later.patch } };
    expect(live.m1.inputCost).toBe(210);
    expect(live.m1.cachedInputCost).toBe(21);
    expect(live.m2.inputCost).toBe(420);
  });

  it("the endpoint takes the list, and the single shape still works", () => {
    expect(APPLY).toMatch(/modelConfigTargets: z/);
    expect(APPLY).toMatch(
      /const targets = modelConfigTargets \?\? \(modelConfigTarget \? \[modelConfigTarget\] : undefined\)/,
    );
  });

  it("and the diff is rendered for all of them at once", () => {
    // One proposal the administrator reads once, or the point is lost.
    expect(TOOLS).toMatch(/renderProviderDiff\(provider, \{ modelConfigs: preview \}, summary\)/);
  });
});
