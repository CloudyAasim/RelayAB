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