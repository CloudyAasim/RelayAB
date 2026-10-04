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
 *
 * Both sides are read at runtime: the offered set from the tool definitions the
 * assistant is actually given, the carried set from the schema the approval
 * endpoint actually parses with. An earlier version of this file matched both
 * against the *text* of the sources, which made it assert the very hand-written
 * copy that caused the bug — so removing the copy broke the guard that existed
 * to complain about it. Text cannot see this class of failure: a field can be
 * present in the file and absent from the behaviour.
 */
import { describe, it, expect } from "vitest";
import { toolDefinitions } from "@/lib/assistant/tools";
import { ModelConfigPatchSchema } from "@/lib/db/types";

/** The fields the proposal tool advertises under `parameters.properties`. */
function offered(): string[] {
  const def = toolDefinitions(true).find(
    (t) => t.function.name === "propose_model_config_update",
  );
  expect(def, "the proposal tool is gone").toBeDefined();
  if (!def) return [];
  const properties = def.function.parameters.properties as
    | Record<string, unknown>
    | undefined;
  expect(properties, "the tool declares no parameters").toBeDefined();
  return Object.keys(properties ?? {});
}

/**
 * The fields the apply path's per-model schema will carry.
 *
 * This is the schema the approval endpoint parses with, which is the shared
 * model-configuration shape — the same one every other write path uses.
 */
function carried(): string[] {
  return Object.keys(ModelConfigPatchSchema.shape);
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
    for (const field of [
      "reasoningLevels",
      "cachedInputCost",
      "cacheWriteCost",
    ]) {
      expect(c, `${field} is not carried through the apply path`).toContain(field);
    }
  });

  it("and a level still cannot be an error field's name on this path either", () => {
    // Checked by parsing, not by reading: the filter lives in the shared schema
    // now, and "the file mentions sanitizeLevelList" would have been satisfied
    // by a comment.
    const parsed = ModelConfigPatchSchema.safeParse({
      upstreamId: "MiniMax-M3.1-Flash-Preview",
      clientId: "m3.1-flash",
      reasoningLevels: ["http_code", "request_id", "low", "medium", "high"],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reasoningLevels).toEqual(["low", "medium", "high"]);
  });

  it("and every field the tool offers survives a real parse of the payload", () => {
    // The same comparison, done with values rather than names: each offered
    // field is handed to the apply schema and must come out the far side.
    const ENVELOPE = new Set(["providerId", "summary"]);
    const properties = (
      toolDefinitions(true).find(
        (t) => t.function.name === "propose_model_config_update",
      )?.function.parameters.properties ?? {}
    ) as Record<string, { type?: string; items?: { type?: string } }>;

    for (const field of Object.keys(properties).filter(
      (f) => !ENVELOPE.has(f),
    )) {
      const spec = properties[field];
      const sample =
        spec?.type === "array"
          ? ["low", "high"]
          : // "integer" and "number" both land on a value the schema will take;
            // anything else gets a string, which a numeric field will reject —
            // correctly, and for a reason that has nothing to do with parity.
            spec?.type === "number" || spec?.type === "integer"
            ? 1
            : spec?.type === "boolean"
              ? true
              : "x";
      const parsed = ModelConfigPatchSchema.safeParse({
        upstreamId: "u",
        clientId: "c",
        [field]: sample,
      });
      expect(parsed.success, `${field} is rejected by the apply path`).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data).toHaveProperty(field);
    }
  });
});
