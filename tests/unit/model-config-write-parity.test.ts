/**
 * Every path that can write a model's configuration must accept the same
 * fields, and must not quietly drop any of them.
 *
 * This exists because the field list was written out separately in five places
 * and the copies drifted apart. The failure was silent in the worst way: a
 * proposal was offered a field, the write path's schema did not name it, and
 * because Zod strips unknown keys rather than rejecting them, the change came
 * back reported as applied with the field gone. The only version of the
 * proposal that appeared to work was the one carrying nothing.
 *
 * So this test does not read the source. It imports the four schemas the four
 * routes actually parse with and hands each one the same payload. A field is
 * "supported by a path" only if that path's own schema keeps it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PostSchema } from "@/app/api/admin/providers/route";
import { PatchSchema } from "@/app/api/admin/providers/[id]/route";
import { ModelEntrySchema } from "@/app/api/admin/model-config/route";
import { ModelConfigSchema, ModelConfigPatchSchema } from "@/lib/db/types";

/**
 * The single model-config schema out of a body field that holds a record of
 * them, so all four paths can be handed the same single-model payload.
 */
function entrySchemaOf(
  field: z.ZodTypeAny,
): z.ZodType<Record<string, unknown>> {
  const unwrapped = field instanceof z.ZodOptional ? field.unwrap() : field;
  // Zod 3 exposes a record's value schema on `_def`; there is no public
  // accessor for it. Unwrapping it is the whole point — the record is what the
  // route parses, the value is the shape this test is about.
  const value = (unwrapped as unknown as { _def: { valueType: z.ZodTypeAny } })
    ._def.valueType;
  return value as z.ZodType<Record<string, unknown>>;
}

/**
 * The four model-config entry schemas, keyed by the path that owns them.
 *
 * Three arrive as a field of a larger body schema; the assistant path's is the
 * shape itself. Pulling the entry schema out of each puts all four on the same
 * footing: each one parses a single model config, exactly as it is handed one.
 */
const ENTRY_SCHEMAS: Record<string, z.ZodType<Record<string, unknown>>> = {
  "POST /api/admin/providers": entrySchemaOf(PostSchema.shape.modelConfigs),
  "PATCH /api/admin/providers/:id": entrySchemaOf(
    PatchSchema.shape.modelConfigs,
  ),
  "POST /api/admin/model-config": ModelEntrySchema,
  // The approval body uses the shared schema directly, so there is no local
  // copy left for it to drift from.
  "POST /api/assistant/actions/:id": ModelConfigPatchSchema,
};

/**
 * A model config valid for every path.
 *
 * `providerId` is only declared by the model-config path, which addresses a row
 * by provider; the other three key a provider by the record they are inside. It
 * is included unconditionally because the schemas are not strict, so the paths
 * that do not declare it drop it — which is the same "a field the schema does
 * not name is a field it drops" behaviour this test exists to catch, here
 * happening to something deliberately extraneous.
 */
const BASE: Record<string, unknown> = {
  providerId: "provider-1",
  upstreamId: "MiniMax-M3.1-Flash-Preview",
  clientId: "m3.1-flash",
};

/**
 * One representative value per field. If a path does not keep a field from this
 * table, that path cannot store it.
 */
const FIELD_SAMPLES: Record<string, unknown> = {
  upstreamId: "MiniMax-M3.1-Flash-Preview",
  clientId: "m3.1-flash",
  displayName: "MiniMax M3.1 Flash",
  contextLength: 204_800,
  maxOutputTokens: 32_768,
  inputCost: 1,
  outputCost: 8,
  cachedInputCost: 0.1,
  cacheWriteCost: 1.25,
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  enabled: true,
};

/** The shared shape, as the single source of what a model config can hold. */
const SHARED_FIELDS = Object.keys(
  ModelConfigPatchSchema.shape as Record<string, unknown>,
);

describe("model config write paths", () => {
  it("the shared schema names every field the write paths must keep", () => {
    // Guards the test itself: a field added to the sample table but not to the
    // shared schema would otherwise make every path "differ" for no reason.
    expect(SHARED_FIELDS.sort()).toEqual(Object.keys(FIELD_SAMPLES).sort());
  });

  it("the read shape names every field the write shape does", () => {
    // The same class of bug, pointing the other way. A field added to the
    // write schema but not the read one is accepted from the operator, stored,
    // and then stripped on the way back out — so the UI shows the change as not
    // having happened. The two schemas differ in their *rules* (the read one
    // fills defaults, the write one must not) but they must describe the same
    // set of fields, or one of them is describing a model that cannot exist.
    const readFields = Object.keys(ModelConfigSchema.shape).sort();
    expect(readFields).toEqual([...SHARED_FIELDS].sort());
  });

  it("reads a stored level list back exactly as it was stored", () => {
    // Including a polluted one. A value already in the database is not this
    // layer's to judge: filtering on read would make the whole provider
    // unreadable over one bad row, and the fix belongs at the write path.
    const stored = ["http_code", "low", "high"];
    const parsed = ModelConfigSchema.safeParse({
      upstreamId: "u",
      clientId: "c",
      reasoningLevels: stored,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.reasoningLevels).toEqual(stored);
  });

  for (const [path, schema] of Object.entries(ENTRY_SCHEMAS)) {
    for (const field of SHARED_FIELDS) {
      it(`${path} keeps \`${field}\``, () => {
        const parsed = schema.safeParse({
          ...BASE,
          [field]: FIELD_SAMPLES[field],
        });
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        // The point of the test: present in the payload AND still present after
        // parsing. A schema that omits the key strips it and still succeeds.
        expect(parsed.data).toHaveProperty(field);
      });
    }
  }
});

describe("model config write paths — the values themselves", () => {
  it("keeps an explicitly free cache read, distinct from an unset one", () => {
    // 0 means "the cache read is free". If any path's schema defaulted this
    // field to 0, every model would silently become free to read from cache.
    const parsed = ModelConfigPatchSchema.safeParse({
      upstreamId: "u",
      clientId: "c",
      cachedInputCost: 0,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.cachedInputCost).toBe(0);
  });

  it("filters envelope field names out of the levels on every path", () => {
    // The shape that really happened: a parser that took the keys of the
    // provider's refusal and called them the list of levels the model accepts.
    const polluted = ["http_code", "request_id", "low", "medium", "high"];
    for (const [path, schema] of Object.entries(ENTRY_SCHEMAS)) {
      const parsed = schema.safeParse({
        ...BASE,
        reasoningLevels: polluted,
      });
      expect(parsed.success, path).toBe(true);
      if (!parsed.success) continue;
      expect((parsed.data as { reasoningLevels: string[] }).reasoningLevels).toEqual([
        "low",
        "medium",
        "high",
      ]);
    }
  });

  it("rejects a negative price, so a refund cannot be configured", () => {
    const parsed = ModelConfigPatchSchema.safeParse({
      upstreamId: "u",
      clientId: "c",
      inputCost: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it("requires the two identifiers a row cannot exist without", () => {
    expect(ModelConfigPatchSchema.safeParse({ clientId: "c" }).success).toBe(false);
    expect(ModelConfigPatchSchema.safeParse({ upstreamId: "u" }).success).toBe(false);
  });
});
