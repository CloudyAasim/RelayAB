/**
 * The assistant has to be able to read back what it wrote.
 *
 * `list_providers` returned five fields per model and stopped. The other four
 * prices and the effort declaration were not in the output, and from in there
 * the difference between "this model is free" and "this field is not reported"
 * does not exist. That gap produced a specific wrong answer twice in one
 * session: the assistant reported that the prices had never been configured,
 * and later that eight approved proposals were still pending — both times
 * concluding from an absent key, and the second time contradicting the user
 * while sounding like it had checked.
 *
 * A tool that cannot read a field back cannot be used to verify a change made
 * with the tools beside it. That is the whole of this test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolDefinitions } from "@/lib/assistant/tools";
import { ModelConfigPatchSchema, ModelConfigSchema } from "@/lib/db/types";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf8");
const TOOLS = read("src", "lib", "assistant", "tools.ts");

/** The admin tool that reads provider configuration. */
const listProviders = toolDefinitions(true).find(
  (t) => t.function.name === "list_providers",
);
expect(listProviders, "list_providers is gone").toBeDefined();

describe("the configuration read-back covers the configuration write paths", () => {
  /**
   * Every field a write path accepts, minus the two that are not per-model
   * configuration: `clientId` is the map key, `upstreamId` is reported on its
   * own line already.
   */
  const FIELDS = Object.keys(ModelConfigPatchSchema.shape).filter(
    (f) => f !== "clientId" && f !== "upstreamId",
  );

  it("names every writable per-model field in the read", () => {
    // A field that can be written but not read is a field nobody can check, and
    // "nobody can check" is how four models sat at a price of zero for as long
    // as they did.
    for (const field of FIELDS) {
      expect(TOOLS, `list_providers never mentions ${field}`).toContain(field);
    }
  });

  it("reports the four prices rather than folding them away", () => {
    for (const field of [
      "inputCost",
      "outputCost",
      "cachedInputCost",
      "cacheWriteCost",
    ]) {
      expect(TOOLS).toMatch(new RegExp(`${field}: c\\.${field} \\?\\? null`));
    }
  });

  it("reports all three states of a declared-or-not flag, not two", () => {
    // This used to read `=== false ? false : null`, folding a stored `true` into
    // "nobody declared it". That was accurate for as long as
    // `ModelConfigSchema` defaulted an absent field to `true`, which made the
    // two genuinely indistinguishable. That default is gone, so the read reports
    // what is stored: `true` says the vendor supports it, `false` says it does
    // not, `null` says nobody has said.
    //
    // Folding them again is not a simplification — it is how a model with a
    // working thinking switch was described as having no switch at all, after
    // the switch had been correctly declared.
    for (const field of ["reasoningEffortSupported", "thinkingSwitchSupported"]) {
      expect(TOOLS, `${field} is not reported as stored`).toMatch(
        new RegExp(`${field}: c\\.${field} \\?\\? null`),
      );
      expect(TOOLS, `${field} still folds a declared yes into "not declared"`).not.toMatch(
        new RegExp(`${field}:\\s*\\n?\\s*c\\.${field} === false`),
      );
    }
  });

  it("and the stored value is what a read produces, not a default", () => {
    // The read is only honest if the three states actually reach it. A schema
    // that fills an absent field in cannot report "nobody said", and the two
    // guards above would both pass while the tool lied to the model reading it.
    const undeclared = ModelConfigSchema.parse({ upstreamId: "m", clientId: "c" });
    expect(undeclared.thinkingSwitchSupported).toBeUndefined();
    expect(undeclared.reasoningEffortSupported).toBeUndefined();

    const declared = ModelConfigSchema.parse({
      upstreamId: "m",
      clientId: "c",
      thinkingSwitchSupported: true,
      reasoningEffortSupported: true,
    });
    expect(declared.thinkingSwitchSupported).toBe(true);
    expect(declared.reasoningEffortSupported).toBe(true);
  });
});

describe("the assistant can see whether its own proposals landed", () => {
  const defs = toolDefinitions(true).map((t) => t.function.name);

  it("there is a tool for the pending queue", () => {
    // Without one the model proposes, the user clicks, and the only way to
    // report the outcome is to guess — which is what it did, twice, in the same
    // direction.
    expect(defs).toContain("list_my_proposals");
  });

  it("and it is admin-only, like the tools that change things", () => {
    expect(toolDefinitions(false).map((t) => t.function.name)).not.toContain(
      "list_my_proposals",
    );
  });

  it("it is routed to an implementation, not just described", () => {
    // A tool definition without a case in the dispatcher is a tool the model
    // will call and get "unknown tool" back from.
    expect(TOOLS).toMatch(/case "list_my_proposals":/);
    expect(TOOLS).toMatch(/async function listMyProposals\(/);
  });

  it("and it answers the question that is actually asked — is it done yet", () => {
    expect(TOOLS).toContain("statusSummary");
    // `resolvedAt` under its own name: renaming it to `appliedAt` would report
    // a rejected proposal as applied.
    expect(TOOLS).toContain("resolvedAt");
  });
});
