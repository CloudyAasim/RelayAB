/**
 * tests/unit/cache-pricing-surface.test.ts
 *
 * The cache prices are stored in one place and typed in three.
 *
 * `modelConfigs` is a JSON blob, so there was no migration to forget — which is
 * exactly why a field can be added to the type and reach only one of the three
 * doors onto it. The provider editor, the model-notes editor and the assistant's
 * `propose_model_config_update` each spell out their own field list, and they
 * already disagreed about this before: one of them grew a field the other two
 * never heard of, and the disagreement was invisible until somebody edited a
 * price in the page that could not see it.
 *
 * So all three are asserted against the same list. Adding a fourth rate means
 * touching four files, and the test is what makes that visible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf-8");

const PROVIDER_EDITOR = read(
  "src",
  "app",
  "(admin)",
  "admin",
  "providers",
  "ProviderModelsEditor.tsx",
);
const MODEL_ROWS = read("src", "app", "(admin)", "admin", "providers", "model-rows.ts");
const MODEL_CONFIG = read("src", "lib", "admin", "model-config.ts");
const MODEL_CONFIG_ROUTE = read("src", "app", "api", "admin", "model-config", "route.ts");
const PROVIDER_API = read("src", "app", "api", "admin", "providers", "route.ts");
const TOOLS = read("src", "lib", "assistant", "tools.ts");
const USAGE_PAGE = read("src", "app", "(admin)", "admin", "page.tsx");

/** Every rate a model row can carry. The three editors must agree on this list. */
const RATES = ["inputCost", "outputCost", "cachedInputCost", "cacheWriteCost"] as const;

describe("cache pricing: one rate list, typed in three places", () => {
  it("the provider editor offers both cache prices", () => {
    for (const field of RATES) {
      expect(PROVIDER_EDITOR, `the provider editor cannot edit ${field}`).toContain(field);
    }
    expect(PROVIDER_EDITOR).toContain("admin.providers.create.cachedInputCost");
    expect(PROVIDER_EDITOR).toContain("admin.providers.create.cacheWriteCost");
  });

  it("the model-notes editor offers both, and its row model carries both", () => {
    for (const field of RATES) {
      expect(MODEL_CONFIG, `the row model has no ${field}`).toContain(field);
    }
    // The form reads the labels, and the notes form is a separate component
    // from the provider one — which is the whole reason for this file.
    expect(read("src", "app", "(admin)", "admin", "model-notes", "ModelConfigForm.tsx")).toContain(
      "cachedInputCost",
    );
  });

  it("the assistant's tool can set both, and shows both in its diff", () => {
    for (const field of RATES) {
      expect(TOOLS, `propose_model_config_update cannot set ${field}`).toContain(field);
    }
    // A reprice that renders as an empty diff is a price change nobody approved.
    expect(TOOLS, "the diff does not read the stored cache prices").toMatch(
      /existing\.cachedInputCost !== undefined/,
    );
  });

  it("every door accepts them, and none of them defaults them away", () => {
    for (const [name, src] of [
      ["providers API", PROVIDER_API],
      ["model-config API", MODEL_CONFIG_ROUTE],
    ] as const) {
      for (const field of RATES) {
        expect(src, `${name} does not accept ${field}`).toContain(field);
      }
      // A schema default of 0 would make every cache read free the moment
      // anybody saved an unrelated field.
      expect(src, `${name} defaults a cache price`).not.toMatch(
        new RegExp(`${RATES[2]}: z\\.number\\(\\)[^.]*\\.default\\(`),
      );
    }
  });

  it("and the usage table shows what the upstream reported", () => {
    expect(USAGE_PAGE).toContain("admin.overview.usageCache");
    expect(USAGE_PAGE).toContain("row.cachedPromptTokens");
    expect(USAGE_PAGE).toContain("row.cacheWriteTokens");
  });
});

describe("cache pricing: blank is not zero", () => {
  it("the provider editor keeps them apart", () => {
    // `Number("")` is 0, and 0 here means "this cache is free". A field nobody
    // touched would then silently reprice every cached request.
    expect(MODEL_ROWS).toMatch(/cachedInputCost\?: number/);
    expect(MODEL_ROWS).toMatch(/row\.cachedInputCost !== undefined/);
    expect(MODEL_ROWS).not.toMatch(/if \(row\.cachedInputCost > 0\)/);
    // The input side of the editor too: the two cache boxes are their own map
    // precisely because they cannot use the plain numeric handler.
    expect(PROVIDER_EDITOR).toMatch(/raw === "" \? undefined : Number\(raw\)/);
  });

  it("the model-notes route can clear a price, which replacing cannot mean", () => {
    // That page merges, so absent means "keep". `null` is the only way to say
    // "clear it", and without it an operator who typed a price and then emptied
    // the box had no way to undo it.
    expect(MODEL_CONFIG_ROUTE).toMatch(
      /cachedInputCost: z\.number\(\)\.nonnegative\(\)[\s\S]{0,40}?\.nullable\(\)/,
    );
    expect(MODEL_CONFIG_ROUTE).toMatch(/delete configs\[entry\.clientId\]\.cachedInputCost/);
    expect(MODEL_CONFIG).toMatch(/cachedInputCost: r\.cachedInputCost \?\? null/);
  });
});

describe("cache pricing: the parsers read what the vendors send", () => {
  const OPENAI = read("src", "lib", "proxy", "openai.ts");
  const ANTHROPIC = read("src", "lib", "proxy", "anthropic.ts");
  const BILLING = read("src", "lib", "proxy", "billing.ts");

  it("both surfaces of the OpenAI proxy pass the buckets on", () => {
    // The stream and the buffered response are separate code paths, and the
    // omission in this feature was in both of them. The stream assertion is on
    // the *extractor*, not just on the call site: a stream usage frame that
    // stopped carrying the cache would still satisfy `cache: sawUsage ? …`.
    expect(OPENAI).toMatch(/cache: extractCacheBuckets\(usage\)/);
    expect(OPENAI).toMatch(/cache: sawUsage \? usage\.cache :/);
    expect(OPENAI, "the SSE usage frame no longer carries the cache").toMatch(
      /return \{ promptTokens, completionTokens, totalTokens, cache: extractCacheBuckets\(source\) \};/,
    );
  });

  it("and both paths of the Anthropic one", () => {
    expect(ANTHROPIC).toMatch(/cache: extractCacheBuckets\(usage\)/);
    expect(ANTHROPIC).toMatch(/cache = extractCacheBuckets\(usage\)/);
    // Declared on the response type as well, or the fields parse and go unread
    // again — which is how this whole feature was missing for so long.
    expect(ANTHROPIC).toMatch(/usage: \{[\s\S]{0,200}cache_read_input_tokens\?: number/);
  });

  it("settlement records a cache only when one was reported", () => {
    expect(BILLING).toMatch(/\(cache\.reported[\s\S]{0,120}cachedPromptTokens: cache\.read/);
  });
});
