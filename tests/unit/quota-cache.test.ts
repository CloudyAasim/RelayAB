/**
 * Prompt-cache pricing.
 *
 * Cached input is the one part of a request that is *not* billed at the input
 * price, and the whole system had no way to say so: `computeCredits` took two
 * numbers, the rate had two fields, and a cached request cost exactly what an
 * uncached one did.
 *
 * Two facts make this harder than "read one more field":
 *
 *  1. **No standard spelling.** OpenAI nests a subset under
 *     `prompt_tokens_details.cached_tokens`; Anthropic reports two disjoint
 *     buckets beside `input_tokens`; DeepSeek names hit and miss separately;
 *     several compatible vendors use a bare `cached_tokens`. All of them arrive
 *     on the same object, already parsed, and were being ignored.
 *
 *  2. **The buckets may or may not be inside the prompt count.** OpenAI's
 *     `prompt_tokens` includes the cached part; Anthropic's `input_tokens` does
 *     not. Guessing wrong one way charges users for tokens nobody paid for;
 *     the other way silently drops the discount. So it is detected per request
 *     rather than configured — see the invariant test below, which is the one
 *     that matters.
 */
import { describe, it, expect } from "vitest";
import {
  computeCredits,
  extractCacheBuckets,
  resolveModelRate,
  type ModelRate,
} from "@/lib/quota/rates";

/** Rates in 积分 per million, which is what a model row holds. */
const rate = (
  inputPerMillion: number,
  outputPerMillion: number,
  cache?: { read?: number; write?: number },
): ModelRate => ({
  inputPerMillion,
  outputPerMillion,
  ...(cache?.read !== undefined ? { cachedInputPerMillion: cache.read } : {}),
  ...(cache?.write !== undefined ? { cacheWritePerMillion: cache.write } : {}),
});

describe("extractCacheBuckets", () => {
  it("reads OpenAI's nested subset", () => {
    const b = extractCacheBuckets({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(b).toEqual({ read: 800, write: 0, reported: true });
  });

  it("reads the Responses spelling, which nests under input_tokens_details", () => {
    expect(extractCacheBuckets({ input_tokens_details: { cached_tokens: 640 } }).read).toBe(640);
  });

  it("reads Anthropic's two disjoint buckets", () => {
    const b = extractCacheBuckets({
      input_tokens: 200,
      output_tokens: 30,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 900,
    });
    expect(b).toEqual({ read: 900, write: 500, reported: true });
  });

  it("reads the alternative cache_creation spelling some vendors use", () => {
    expect(extractCacheBuckets({ cache_creation_tokens: 250 }).write).toBe(250);
  });

  it("reads DeepSeek's hit counter", () => {
    expect(extractCacheBuckets({ prompt_cache_hit_tokens: 700 }).read).toBe(700);
  });

  it("reads a bare cached_tokens, the shape most compatible vendors copy", () => {
    expect(extractCacheBuckets({ cached_tokens: 300 }).read).toBe(300);
  });

  it("reports nothing when the vendor reported no cache at all", () => {
    // Absent, not zero: "this model has no caching" and "0% hit rate" are
    // different facts, and only the first is a claim about the provider.
    expect(extractCacheBuckets({ prompt_tokens: 100, completion_tokens: 5 })).toEqual({
      read: 0,
      write: 0,
      reported: false,
    });
    expect(extractCacheBuckets(undefined).reported).toBe(false);
    expect(extractCacheBuckets("nonsense").reported).toBe(false);
  });

  it("treats a zero or nonsense bucket as not reported", () => {
    expect(extractCacheBuckets({ prompt_tokens_details: { cached_tokens: 0 } }).reported).toBe(false);
    expect(extractCacheBuckets({ cached_tokens: -5 }).read).toBe(0);
  });

  it("takes the largest plausible hit rather than the first field found", () => {
    // The wrong-but-smaller number is the one that quietly under-discounts, so
    // the fields are combined rather than short-circuited. Ordered so the larger
    // one is *last* in the expression a `||` chain would use — otherwise the
    // test passes with either implementation.
    expect(
      extractCacheBuckets({
        prompt_tokens_details: { cached_tokens: 100 },
        cache_read_input_tokens: 900,
      }).read,
    ).toBe(900);
    expect(
      extractCacheBuckets({ cached_tokens: 100, prompt_cache_hit_tokens: 900 }).read,
    ).toBe(900);
  });
});

describe("computeCredits with a prompt cache", () => {
  it("bills the cached portion at the cache rate and the rest at the input rate", () => {
    // OpenAI's convention: the cache is a subset of the prompt.
    const credits = computeCredits({
      rate: rate(1000, 2000, { read: 100 }),
      promptTokens: 1_000_000,
      completionTokens: 0,
      cache: { read: 800_000, write: 0, reported: true },
    });
    // 200k uncached × 1000 + 800k cached × 100 = 200M + 80M = 280M → 280_000
    expect(credits).toBe(280_000);
  });

  it("adds Anthropic's disjoint buckets on top of its uncounted prompt", () => {
    const credits = computeCredits({
      rate: rate(1000, 0, { read: 100, write: 1250 }),
      promptTokens: 200_000,
      completionTokens: 0,
      cache: { read: 800_000, write: 500_000, reported: true },
    });
    // read + write (1.3M) > prompt (200k), so the buckets are disjoint:
    // 200k × 1000 + 800k × 100 + 500k × 1250 = 200M + 80M + 625M = 905M → 905_000
    expect(credits).toBe(905_000);
  });

  it("never charges more than full input price for every token processed", () => {
    // The invariant. Which convention a vendor uses is unknowable from here, so
    // the guarantee cannot be "no more than the old formula" — under the
    // Anthropic shape the old formula *undercounted*, because its buckets were
    // never added to anything. The property that has to hold for every mixture
    // is the upper one: the result is a correct reading of one convention, and
    // never more than charging list price on every token the upstream actually
    // processed.
    const base = rate(1000, 500);
    const cases = [
      { prompt: 1_000_000, read: 0, write: 0 },
      { prompt: 1_000_000, read: 999_999, write: 0 },
      { prompt: 1_000_000, read: 0, write: 999_999 },
      { prompt: 1_000_000, read: 600_000, write: 600_000 },
      { prompt: 1_000_000, read: 2_000_000, write: 0 },
      { prompt: 10, read: 5, write: 0 },
      { prompt: 10, read: 5, write: 5 },
      { prompt: 10, read: 9, write: 9 },
      { prompt: 10, read: 40, write: 0 },
    ];
    for (const c of cases) {
      const bound = computeCredits({
        rate: base,
        promptTokens: c.prompt + c.read + c.write,
        completionTokens: 0,
      });
      const actual = computeCredits({
        rate: base,
        promptTokens: c.prompt,
        completionTokens: 0,
        cache: { read: c.read, write: c.write, reported: true },
      });
      expect(actual, `prompt=${c.prompt} read=${c.read} write=${c.write}`).toBeLessThanOrEqual(bound);
    }
  });

  it("and a misread convention undercharges rather than overcharges", () => {
    // The residual risk, stated rather than hidden. A vendor using the disjoint
    // shape but reporting fewer cached tokens than its prompt count would be
    // read as the subset convention, and the discount would be lost. That is
    // the safe direction: it costs revenue for one turn, it does not invoice a
    // user for tokens nobody paid for.
    const rate0 = rate(1000, 0, { read: 100 });
    // Anthropic-shaped request whose buckets happen to be smaller than the
    // prompt: read as a subset, so the uncached remainder is 900k.
    const misread = computeCredits({
      rate: rate0,
      promptTokens: 1_000_000,
      completionTokens: 0,
      cache: { read: 100_000, write: 0, reported: true },
    });
    const fullPrice = computeCredits({
      rate: rate0,
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(misread).toBeLessThan(fullPrice);
  });

  it("is unchanged when no cache was reported", () => {
    // A caller that does not look at the cache must bill exactly what it billed
    // before this existed, or every model configured in the last year would
    // silently change price.
    const args = { rate: rate(1000, 2000), promptTokens: 1234, completionTokens: 567 };
    expect(computeCredits(args)).toBe(computeCredits({ ...args, cache: undefined }));
    expect(computeCredits({ ...args, cache: { read: 0, write: 0, reported: false } })).toBe(
      computeCredits(args),
    );
  });

  it("prices an unconfigured cache at the input rate, not at zero", () => {
    // The default that keeps old model rows safe: a cache read is still an
    // input token unless somebody said otherwise.
    const credits = computeCredits({
      rate: rate(1000, 0),
      promptTokens: 1_000_000,
      completionTokens: 0,
      cache: { read: 1_000_000, write: 0, reported: true },
    });
    expect(credits).toBe(1_000_000);
  });

  it("can express a free cache, which is different from an unconfigured one", () => {
    // Three states, not two: unset means "same as input", 0 means "free".
    const credits = computeCredits({
      rate: rate(1000, 0, { read: 0 }),
      promptTokens: 1_000_000,
      completionTokens: 0,
      cache: { read: 1_000_000, write: 0, reported: true },
    });
    expect(credits).toBe(0);
  });

  it("resolves both cache rates off the model row, keeping three states", () => {
    expect(resolveModelRate({ inputCost: 10, outputCost: 20, cachedInputCost: 1 })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 20,
      cachedInputPerMillion: 1,
    });
    // A 0 is preserved rather than dropped as "missing".
    expect(resolveModelRate({ inputCost: 10, outputCost: 20, cachedInputCost: 0 })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 20,
      cachedInputPerMillion: 0,
    });
    // Unset stays unset, so `computeCredits` can fall back to the input price.
    expect(resolveModelRate({ inputCost: 10, outputCost: 20 })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 20,
    });
  });

  it("ignores nonsense cache counts rather than producing NaN", () => {
    const credits = computeCredits({
      rate: rate(1000, 0, { read: 100 }),
      promptTokens: Number.NaN,
      completionTokens: Number.POSITIVE_INFINITY,
      cache: { read: Number.NaN, write: undefined as never, reported: true },
    });
    expect(credits).toBe(0);
  });
});
