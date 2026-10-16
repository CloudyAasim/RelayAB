/**
 * tests/unit/assistant-free-model-gate.test.ts
 *
 * A free model could not be edited at all.
 *
 * Asked to raise a free model's context length, the assistant was refused three
 * times by the same check:
 *
 *   [all_zero] agnes-2.5-flash：输入和输出都是 0，这个模型会完全不计费。
 *   如果它确实免费请确认；否则这是价格没填。
 *
 * The model *was* free — that was the request ("只添加该提供商的免费模型") and the
 * zeros were already in the row from an earlier proposal. The check reads the
 * merged state after the write, so a proposal containing nothing but
 * `contextLength` merged the same two zeros back in and tripped the same
 * finding. There was no field the model could change to get past it: omitting
 * the prices entirely, which was its second attempt and the correct instinct,
 * changes nothing when the audit reads the result rather than the patch.
 *
 * So a provider with one free model in it had that model permanently frozen for
 * the batch tool — and the user request was the opposite of what tripped it.
 *
 * Three things had to change together. Scoping the check to the patch alone
 * would leave the genuine case — deliberately setting a model to zero — with no
 * way through, so the refusal needs an answer; and the single-model tool had no
 * check at all, so any fix to the batch tool that ignored it would have taught
 * the model which tool to reach for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditModelConfigs,
  partitionFindings,
  renderFindingsRefusal,
  findingKey,
} from "@/lib/providers/config-audit";
import { toolDefinitions } from "@/lib/assistant/tools";

const TOOLS = readFileSync(
  join(process.cwd(), "src", "lib", "assistant", "tools.ts"),
  "utf-8",
);

type Row = Record<string, unknown>;

/** A model that is free and correctly so, which is what the request asked for. */
const FREE_LIVE: Row = {
  enabled: true,
  inputCost: 0,
  outputCost: 0,
  contextLength: 128_000,
  maxOutputTokens: 8_192,
};

describe("a free model is editable again", () => {
  it("a patch that does not touch the prices is not blocked by all_zero", () => {
    // The whole incident, in one call. `contextLength` is the only thing written.
    const findings = auditModelConfigs(
      { "agnes-2.5-flash": { ...FREE_LIVE, contextLength: 524_288 } },
      { patches: { "agnes-2.5-flash": { contextLength: 524_288 } } },
    );
    expect(findings.map((f) => `${f.code}:${f.clientId}`)).toContain(
      "all_zero:agnes-2.5-flash",
    );
    // Still reported — the provider really is free and a reader should see it.
    expect(findings.length).toBeGreaterThan(0);
    // But it is no longer this proposal's problem.
    expect(findings.every((f) => !f.blocking)).toBe(true);
  });

  it("and a patch that does write the zero prices is still blocked", () => {
    // The original protection, untouched. Scoping the check is not the same as
    // removing it: five models once sat at zero billing nothing, and a proposal
    // that puts them there is still the one that needs a question asked.
    const findings = auditModelConfigs(
      { "agnes-2.5-flash": { ...FREE_LIVE, contextLength: 524_288 } },
      { patches: { "agnes-2.5-flash": { inputCost: 0, outputCost: 0 } } },
    );
    expect(findings.some((f) => f.code === "all_zero" && f.blocking)).toBe(true);
  });

  it("re-enabling a free model is also blocked, since that is the same risk", () => {
    // The model is switched off today; this proposal switches it on, and a free
    // model that starts routing is a free model that starts being served.
    const findings = auditModelConfigs(
      { "agnes-2.5-flash": { ...FREE_LIVE, enabled: true } },
      { patches: { "agnes-2.5-flash": { enabled: true } } },
    );
    expect(findings.some((f) => f.code === "all_zero" && f.blocking)).toBe(true);
  });

  it("with no patches given, the check keeps reporting at full severity", () => {
    // `audit_provider_config` asks "is this configuration suspicious", not
    // "should this write be allowed". The two answers must not be merged.
    const findings = auditModelConfigs({ "agnes-2.5-flash": FREE_LIVE });
    expect(findings.some((f) => f.code === "all_zero" && f.blocking)).toBe(true);
  });
});

describe("the operator may declare a model free", () => {
  it("confirming a finding moves it out of the way", () => {
    const findings = auditModelConfigs(
      { "agnes-2.5-flash": { ...FREE_LIVE, contextLength: 524_288 } },
      { patches: { "agnes-2.5-flash": { inputCost: 0, outputCost: 0 } } },
    );
    const { blocking, acknowledged } = partitionFindings(findings, [
      findingKey("all_zero", "agnes-2.5-flash"),
    ]);
    expect(blocking).toEqual([]);
    expect(acknowledged.map((f) => f.clientId)).toEqual(["agnes-2.5-flash"]);
  });

  it("and it is per model, not a blanket yes for the next one", () => {
    // Declaring one model free is not a statement about its neighbour.
    const findings = auditModelConfigs(
      {
        "agnes-2.5-flash": { ...FREE_LIVE },
        "agnes-3.0-flash": { ...FREE_LIVE },
      },
      {
        patches: {
          "agnes-2.5-flash": { inputCost: 0, outputCost: 0 },
          "agnes-3.0-flash": { inputCost: 0, outputCost: 0 },
        },
      },
    );
    const { blocking } = partitionFindings(findings, [
      findingKey("all_zero", "agnes-2.5-flash"),
    ]);
    expect(blocking.map((f) => f.clientId)).toEqual(["agnes-3.0-flash"]);
  });

  it("and a refusal names the way out instead of asking for a repeat", () => {
    const findings = auditModelConfigs(
      { "agnes-2.5-flash": { ...FREE_LIVE } },
      { patches: { "agnes-2.5-flash": { inputCost: 0, outputCost: 0 } } },
    );
    const text = renderFindingsRefusal(findings, findings);
    expect(text).toContain("all_zero:agnes-2.5-flash");
    expect(text).toContain("confirmFindings");
    // The old line was advice that produced the identical failure, and it is
    // what sent the assistant round the same wall three times.
    expect(text).not.toContain("确认无误就再说一次");
    expect(text).toContain("不要再原样重发一遍");
  });
});

describe("both proposal tools behave the same", () => {
  const tools = toolDefinitions(true);

  /** The source of one tool handler, up to the next top-level function. */
  function toolBody(name: string): string {
    const start = TOOLS.indexOf(`async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = TOOLS.slice(start + 1).search(/\n(?:export )?(?:async )?function [A-Za-z]/);
    const end = next < 0 ? TOOLS.length : start + 1 + next;
    return TOOLS.slice(start, end);
  }

  it.each(["propose_model_configs_update", "propose_model_config_update"])(
    "%s accepts confirmFindings",
    (name) => {
      const def = tools.find((t) => t.function.name === name)!;
      const params = def.function.parameters as { properties?: Record<string, unknown> };
      expect(Object.keys(params.properties ?? {}), `${name} has no confirmFindings`).toContain(
        "confirmFindings",
      );
    },
  );

  it.each([
    ["propose_model_configs_update", "proposeModelConfigsUpdate"],
    ["propose_model_config_update", "proposeModelConfigUpdate"],
  ])("%s runs the gate", (tool, fn) => {
    // The single-model tool had no check at all, which made splitting one model
    // off the batch call a documented way to skip it — so a fix that only landed
    // on the batch tool would have taught the model which tool to reach for.
    const body = toolBody(fn);
    expect(body, `${fn} does not audit`).toMatch(/auditModelConfigs\(/);
    expect(body, `${fn} accepts no confirmation`).toMatch(/partitionFindings\(/);
    expect(body, `${fn} refuses without naming a way out`).toMatch(/renderFindingsRefusal\(/);
  });
});

/**
 * Which tools carry the gate, worked out rather than listed.
 *
 * The `it.each` above names two tools, and those two were the two that had it.
 * `propose_provider_update` and `propose_provider_create` both write
 * `modelConfigs` — one to fill in a config for every model the mapping names,
 * the other to build the whole provider — and neither called the audit. The
 * first rebuilt each row from eight known fields, writing `inputCost: 0` and
 * `outputCost: 0` literally, so asking to add one model marked every model that
 * provider had as free, dropped `cachedInputCost`, `cacheWriteCost`,
 * `reasoningLevels`, `reasoningEffortSupported` and `thinkingSwitchSupported`
 * on the way, and raised no `all_zero` finding — the check that exists for
 * exactly that was never called on that path. The second has no price
 * parameter at all, so every provider it created was free whether or not
 * anyone had decided that.
 *
 * Nothing here was invisible. Both tools declared `confirmFindings` in their
 * schema — `propose_provider_update` did, `propose_provider_create` did not —
 * and neither read it. A field can be offered to the model and never
 * consumed, and every test stays green.
 *
 * So the list of gated tools is derived from the source instead. Adding a tool
 * that writes modelConfigs without the gate now fails here rather than in a
 * production invoice.
 */
describe("every tool that writes modelConfigs carries the gate", () => {
  const tools = toolDefinitions(true);

  /** Handler name for a tool, from its snake_case definition name. */
  const handlerFor = (toolName: string): string =>
    toolName.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

  function toolBody(fn: string): string {
    // Some tools are handled inline in the `executeTool` switch rather than by a
    // named function; there is no source span to read for those, so they
    // contribute nothing here. The exact-list assertion below is what keeps
    // that from becoming a silent gap.
    const start = TOOLS.indexOf(`async function ${fn}(`);
    if (start < 0) return "";
    const next = TOOLS.slice(start + 1).search(/\n(?:export )?(?:async )?function [A-Za-z]/);
    const end = next < 0 ? TOOLS.length : start + 1 + next;
    return TOOLS.slice(start, end);
  }

  /**
   * A tool that *writes* modelConfigs, in any of the three shapes a write
   * takes here: a full table assigned onto the patch or the spec
   * (`patch.modelConfigs = …`, used when a mapping is replaced wholesale), or
   * per-model targets that apply merges in (`args: { modelConfigTargets }`).
   *
   * Reading one — `auditProviderConfig` reports on what is there without
   * changing it — is not a write and must not be gated, or the diagnosis tool
   * would start refusing to answer questions.
   */
  const WRITES_MODEL_CONFIGS = /(?:patch|spec)\.modelConfigs\s*=/;
  const WRITES_MODEL_TARGETS = /modelConfigTargets/;
  const writers = tools
    .map((t) => t.function.name)
    .map((name) => ({ tool: name, fn: handlerFor(name), body: toolBody(handlerFor(name)) }))
    .filter(({ body }) => WRITES_MODEL_CONFIGS.test(body) || WRITES_MODEL_TARGETS.test(body));

  // First, because everything below iterates this list. An empty one would
  // make every loop body run zero times and this file would still be green.
  it("finds the tools that write modelConfigs", () => {
    expect(writers.map((w) => w.tool).sort()).toEqual(
      [
        "propose_model_configs_update",
        "propose_provider_create",
        "propose_provider_update",
      ].sort(),
    );
  });

  it.each(writers.map((w) => [w.tool, w.fn]))("%s audits", (tool, fn) => {
    expect(toolBody(fn), `${tool} writes modelConfigs without the gate`).toMatch(
      /auditModelConfigs\(/,
    );
  });

  it.each(writers.map((w) => [w.tool, w.fn]))("%s has a way out", (tool, fn) => {
    const body = toolBody(fn);
    expect(body, `${tool} refuses with no way to proceed`).toMatch(/partitionFindings\(/);
    expect(body, `${tool} refuses without naming confirmFindings`).toMatch(
      /renderFindingsRefusal\(/,
    );
  });

  it.each(writers.map((w) => [w.tool]))("%s offers confirmFindings to the model", (tool) => {
    const def = tools.find((t) => t.function.name === tool)!;
    const params = def.function.parameters as { properties?: Record<string, unknown> };
    // A gate whose way out is not in the schema refuses forever: the model
    // cannot name the thing that would let it through.
    expect(
      Object.keys(params.properties ?? {}),
      `${tool} can refuse but cannot confirm — the refusal has no exit`,
    ).toContain("confirmFindings");
  });
});
describe("adding a model is not a claim that it is free", () => {
  /**
   * The distinction the whole gate turns on, and the one that is invisible in
   * the state it inspects.
   *
   * A brand-new model's row reads `inputCost: 0, outputCost: 0, enabled: true`
   * — exactly the shape `all_zero` refuses. But those zeros were written by
   * `propose_provider_update`'s mapping branch, which **has no price parameter
   * at all**: nobody stated anything about price. Filling the patch with the
   * built row therefore made the finding blocking on every single addition, and
   * the only way past it was `confirmFindings` — i.e. the model had to assert
   * something it had no means of expressing, or the administrator could not
   * register a single vendor.
   *
   * `all_zero` names `["inputCost","outputCost","enabled"]`, so leaving those
   * three out of the mapping patch is what makes the difference. The protection
   * is not lost, because the tools where the statement is real pass the model's
   * own fields: setting a price of zero, or re-enabling one, still lands those
   * keys in the patch and still refuses.
   */
  it("the mapping branch does not put a price or an enabled flag in the patch", () => {
    const start = TOOLS.indexOf("async function proposeProviderUpdate");
    expect(start, "proposeProviderUpdate not found").toBeGreaterThan(-1);
    const branch = TOOLS.slice(
      start,
      TOOLS.indexOf("for (const gone of Object.keys(configs))", start),
    );

    const patchForNewModel = branch.slice(branch.indexOf("mappingTouched[client] ="));
    expect(patchForNewModel, "the mapping patch is gone").toContain("upstreamId: upstream");

    // The three fields `all_zero` looks for.
    for (const field of ["inputCost", "outputCost", "enabled"]) {
      const declaresIt = new RegExp(`(^|[^\\w.])${field}\\s*:`).test(patchForNewModel);
      expect(
        declaresIt,
        `the mapping patch declares ${field}, so a newly added model reads as a ` +
          `free model the model never claimed — the gate will refuse every addition`,
      ).toBe(false);
    }
  });

  it("and a model that does state a price of zero is still refused", () => {
    // The other half of the same distinction, so the fix cannot be read as
    // "the gate no longer applies to modelMapping's neighbours".
    const single = TOOLS.slice(
      TOOLS.indexOf("async function proposeModelConfigUpdate"),
      TOOLS.length,
    );
    expect(single).toMatch(/auditModelConfigs\(/);
    expect(single).toMatch(/partitionFindings\(/);
    expect(single, "the single-model tool cannot confirm either").toMatch(
      /renderFindingsRefusal\(/,
    );
  });
});
