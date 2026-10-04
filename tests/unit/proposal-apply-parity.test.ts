/**
 * tests/unit/proposal-apply-parity.test.ts
 *
 * A field the proposal offers and the apply path drops looks like a field that
 * does not work.
 *
 * `propose_model_config_update` advertised `reasoningLevels` (and the two cache
 * prices) for weeks while the schema that validates an action when it is
 * **applied** had never heard of them. Zod strips what it does not recognise, so
 * the action came back "applied" with the field silently gone — and the only
 * version that appeared to take effect was the one carrying nothing. Nine
 * models kept levels the vendor never claimed for exactly that long.
 *
 * So the two shapes are compared, field by field. A field may be added to
 * either freely; being *offered* without being *carried* is the bug, and this
 * is the only check that can see it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const TOOLS = read("src", "lib", "assistant", "tools.ts");
const APPLY = read("src", "app", "api", "assistant", "actions", "[id]", "route.ts");

/** The fields the proposal tool advertises under `parameters.properties`. */
function offered(): string[] {
  const at = TOOLS.indexOf('name: "propose_model_config_update"');
  expect(at, "the proposal tool is gone").toBeGreaterThan(-1);
  const start = TOOLS.indexOf("properties: {", at);
  const end = TOOLS.indexOf("required:", start);
  const block = TOOLS.slice(start, end > 0 ? end : start + 4000);
  return [...block.matchAll(/^\s{10}(\w+): \{/gm)].map((m) => m[1]);
}

/** The fields the apply path's per-model schema will carry. */
function carried(): string[] {
  const at = APPLY.indexOf("const ModelConfigSchema = z.object({");
  expect(at, "the apply schema is gone").toBeGreaterThan(-1);
  const block = APPLY.slice(at, APPLY.indexOf("});", at));
  return [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

describe("what the assistant offers and what the apply path carries", () => {
  it("are the same set of fields", () => {
    // The envelope answers *which* model and *why*, and is consumed by the tool
    // before a per-model config is built — so it is not part of the config and
    // its absence from that schema is correct rather than a dropped field.
    const ENVELOPE = new Set(["providerId", "summary"]);
    const o = offered().filter((f) => !ENVELOPE.has(f));
    const c = carried();
    expect(o.length, "no fields found in the proposal tool").toBeGreaterThan(3);
    const dropped = o.filter((f) => !c.includes(f));
    expect(
      dropped,
      `offered by the tool but dropped when applied: ${dropped.join(", ")} — they are stripped silently, so the change reports success and does nothing`,
    ).toEqual([]);
  });

  it("and the fields that must travel together are all three of them", () => {
    // Named explicitly because they were the three that were missing, and
    // because a future edit that reorders the proposal is more likely to break
    // one of them than any of the others.
    const c = carried();
    for (const field of ["reasoningLevels", "cachedInputCost", "cacheWriteCost"]) {
      expect(c, `${field} is not carried through the apply path`).toContain(field);
    }
  });

  it("and a level still cannot be an error field's name on this path either", () => {
    expect(APPLY, "the apply path does not filter the levels").toMatch(
      /\.transform\(\(levels\) => sanitizeLevelList\(levels\)\)/,
    );
  });
});
