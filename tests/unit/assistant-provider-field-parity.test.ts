/**
 * tests/unit/assistant-provider-field-parity.test.ts
 *
 * The tool promised a field the apply route refused.
 *
 * `propose_provider_update` documents and accepts `upstreamFormat`, writes it
 * into the proposal's patch, and `renderProviderDiff` draws it as a line the
 * administrator is asked to confirm. `ProviderArgsSchema` is `.strict()` and did
 * not list it — so the sequence was: the assistant proposed it, the screen showed
 * the diff, the administrator approved it, and the parse at apply time threw
 * `unrecognized_keys` and failed **the whole proposal**, taking every other field
 * in it down too.
 *
 * `headers` was missing from the same schema, for the same reason. The create
 * schema had the same gap for `headers`; that one is still there, because
 * `propose_provider_create` never offered the field — so the guard below is what
 * would catch it the day somebody adds it to the tool.
 *
 * The failure mode this file exists for is not "a field is missing". It is that
 * **nothing in the build ever compared the two lists**. The tool definition is
 * what the model reads; the apply schema is what the server enforces. A field can
 * sit in only one of them for as long as it likes and every test stays green —
 * the mismatch surfaces as a proposal an administrator approves and then loses.
 *
 * So this compares them directly. Both sides are read at runtime rather than
 * parsed out of source: the tool's declared parameter names come from the
 * `toolDefinitions()` the model actually receives, and the schema's keys come
 * from the Zod shape the apply actually runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { toolDefinitions } from "@/lib/assistant/tools";
import {
  ProviderArgsSchema,
  ProviderCreateSchema,
} from "@/lib/assistant/proposal-validation";

/**
 * The apply path's rules, from both files they live in.
 *
 * The route now calls `checkProposal` and the formatting that renders a refusal
 * moved beside it, so a search of the route alone would find the call and none
 * of the behaviour. The assertions below are about what an administrator and
 * the assistant are told, and both of those live in the module now.
 */
const ROUTE_SRC =
  readFileSync(
    join(process.cwd(), "src", "app", "api", "assistant", "actions", "[id]", "route.ts"),
    "utf-8",
  ) +
  "\n" +
  readFileSync(join(process.cwd(), "src", "lib", "assistant", "proposal-validation.ts"), "utf-8");

/** The parameter names the model is shown for a tool. */
function declaredParams(toolName: string): string[] {
  const def = toolDefinitions(true).find((t) => t.function.name === toolName);
  expect(def, `${toolName} is not offered to an administrator`).toBeTruthy();
  const params = def!.function.parameters as { properties?: Record<string, unknown> };
  return Object.keys(params.properties ?? {});
}

/** The keys a Zod object will accept. */
function acceptedKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

/** The enum values the model is shown for one parameter, if it is shown any. */
function declaredEnum(toolName: string, field: string): string[] | null {
  const def = toolDefinitions(true).find((t) => t.function.name === toolName);
  const params = def!.function.parameters as {
    properties?: Record<string, { enum?: string[] }>;
  };
  return params.properties?.[field]?.enum ?? null;
}

/** The enum values a Zod field accepts. */
function acceptedEnum(field: unknown): string[] | null {
  // Zod wraps a field in `optional()` / `nullable()`, and the enum lives
  // inside the wrapper — so the wrappers are unwrapped before looking.
  let current = field as { _def?: { values?: unknown; innerType?: unknown } } | undefined;
  for (let depth = 0; depth < 5 && current?._def; depth++) {
    const def = current._def;
    if (Array.isArray(def.values)) return def.values as string[];
    current = def.innerType as typeof current;
  }
  return null;
}

/**
 * Fields the proposal carries for the server, not for the patch.
 *
 * `confirmFindings` is here for the same reason as `providerId` and `summary`
 * rather than by exemption: it is consumed before a patch is built, deciding
 * whether a proposal is created at all. The acknowledgement it carries is
 * recorded on the proposal's summary, because a decision is not a
 * configuration field — `proposal-apply-parity.test.ts` states the same rule
 * for the same three keys.
 */
const NOT_PATCH_FIELDS = new Set(["providerId", "summary", "name", "apiKey", "confirmFindings"]);

describe("every field the assistant offers has somewhere to land", () => {
  it("propose_provider_update → ProviderArgsSchema", () => {
    const offered = declaredParams("propose_provider_update").filter((k) => !NOT_PATCH_FIELDS.has(k));
    const accepted = new Set(acceptedKeys(ProviderArgsSchema));

    expect(offered.length, "the tool declares nothing, so this check is vacuous").toBeGreaterThan(4);
    const missing = offered.filter((k) => !accepted.has(k));
    expect(
      missing,
      `propose_provider_update offers ${missing.join(", ")}, which ProviderArgsSchema rejects.\n` +
        "The proposal is created, its diff is shown, the administrator approves it, and the apply\n" +
        "then throws `unrecognized_keys` and fails the whole thing. Add the field to the schema\n" +
        "(mirroring src/app/api/admin/providers/route.ts), not to the tool's description.",
    ).toEqual([]);
  });

  it("propose_provider_create → ProviderCreateSchema", () => {
    const offered = declaredParams("propose_provider_create").filter((k) => !NOT_PATCH_FIELDS.has(k));
    const accepted = new Set(acceptedKeys(ProviderCreateSchema));

    expect(offered.length).toBeGreaterThan(3);
    const missing = offered.filter((k) => !accepted.has(k));
    expect(missing, `propose_provider_create offers ${missing.join(", ")} with nowhere to land`).toEqual(
      [],
    );
  });
});

describe("every value the assistant offers is a value the apply accepts", () => {
  // A name-level parity check cannot see this one: the field was accepted, and
  // one of its *values* was not. The create tool has always offered
  // `upstreamFormat: "gemini"` and its own check accepted it — but the schema
  // refused it, so a proposal to make a Gemini vendor was refused **after** the
  // administrator approved it, which is the one moment an approval cannot be
  // refunded.
  it("propose_provider_create → ProviderCreateSchema", () => {
    const shape = ProviderCreateSchema.shape as Record<string, unknown>;
    let checked = 0;
    for (const [field, def] of Object.entries(shape)) {
      const offered = declaredEnum("propose_provider_create", field);
      const accepted = acceptedEnum(def);
      if (!offered || !accepted) continue;
      checked += offered.length;
      const refused = offered.filter((value) => !accepted.includes(value));
      expect(
        refused,
        `propose_provider_create offers ${field}=${refused.join(", ")}, which ProviderCreateSchema refuses.\n` +
          "The proposal is created, its diff is shown, the administrator approves it, and the apply\n" +
          "then refuses it. Add the value to the schema, not to the tool's description.",
      ).toEqual([]);
    }
    expect(checked, "no enum was compared, so this check is vacuous").toBeGreaterThan(0);
  });

  it("propose_provider_update → ProviderArgsSchema", () => {
    const shape = ProviderArgsSchema.shape as Record<string, unknown>;
    let checked = 0;
    for (const [field, def] of Object.entries(shape)) {
      const offered = declaredEnum("propose_provider_update", field);
      const accepted = acceptedEnum(def);
      if (!offered || !accepted) continue;
      checked += offered.length;
      const refused = offered.filter((value) => !accepted.includes(value));
      expect(
        refused,
        `propose_provider_update offers ${field}=${refused.join(", ")}, which ProviderArgsSchema refuses.`,
      ).toEqual([]);
    }
    expect(checked, "no enum was compared, so this check is vacuous").toBeGreaterThan(0);
  });
});

describe("the two fields that were missing", () => {
  // Named rather than left to the loop above: the loop only says "nothing is
  // missing", and this pair is the whole incident. If a future refactor renames
  // one of them the parity check passes silently, which is exactly the shape of
  // the bug it exists to prevent.
  it("upstreamFormat is accepted on update", () => {
    expect(acceptedKeys(ProviderArgsSchema)).toContain("upstreamFormat");
  });

  it("headers is accepted on update", () => {
    expect(acceptedKeys(ProviderArgsSchema)).toContain("headers");
  });

  it("and the field they accept is one updateProvider can actually write", () => {
    // Adding a key to the schema is only half the fix. If `UpdateProviderInput`
    // did not have it, the parse would succeed and the value would be dropped on
    // the floor — which this codebase calls worse than a rejection.
    const db = readFileSync(join(process.cwd(), "src", "lib", "db", "providers.ts"), "utf-8");
    const input = db.slice(db.indexOf("export interface UpdateProviderInput"));
    for (const field of ["headers", "upstreamFormat"]) {
      expect(input.slice(0, input.indexOf("\n}")), `UpdateProviderInput.${field}`).toContain(field);
    }
    // And the merge reads them, rather than spreading the patch wholesale.
    expect(db).toMatch(/headers: patch\.headers \?\? existing\.headers/);
    expect(db).toMatch(/upstreamFormat: patch\.upstreamFormat \?\? existing\.upstreamFormat/);
  });

  it("and the routing they write ends up on the route table", () => {
    // The columns are the **summary** of the routing, not a second answer to
    // it: the table is written from what the writer said, and the columns are
    // derived from the table. A patch that only mentions the old columns
    // (the assistant's vocabulary) still lands on a table — which it did not
    // before, because the table the row happened to have outvoted it.
    const db = readFileSync(join(process.cwd(), "src", "lib", "db", "providers.ts"), "utf-8");
    expect(db).toMatch(/surfaceRoutes: serializeRoutes\(routing\.routes\)/);
    expect(db).toMatch(/upstreamFormat: routing\.flags\.upstreamFormat/);
    expect(db).toMatch(/legacyPatched/);
  });
});

describe("a rejected proposal says something a reader can act on", () => {
  it("a Zod failure is rendered, not dumped as a JSON array", () => {
    // This is the text that reached the approval screen. It named a field
    // without saying whose fault it was, and it was the *only* thing the
    // assistant got when it needed to know which field to correct.
    expect(ROUTE_SRC).toMatch(/function describeApplyFailure/);
    expect(ROUTE_SRC).toMatch(/err instanceof ZodError/);
    expect(ROUTE_SRC).toMatch(/提案本身的问题/);
  });

  it("and the raw shape is no longer what gets returned", () => {
    expect(ROUTE_SRC).toMatch(/const message = describeApplyFailure\(err\);/);
    // The old ternary that fell through to `err.message`, which for a ZodError
    // is the JSON issue array.
    expect(ROUTE_SRC).not.toMatch(/\?\s*err\.message\s*\n\s*:\s*String\(err\)/);
  });

  it("with the path spelled out, so a nested field is locatable", () => {
    expect(ROUTE_SRC).toMatch(/function describePath/);
    expect(ROUTE_SRC).toMatch(/\$\{acc\}\[\$\{part\}\]/);
  });
});