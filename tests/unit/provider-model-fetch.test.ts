/**
 * tests/unit/provider-model-fetch.test.ts
 *
 * "Fetch models" used to answer half a question.
 *
 * Two separate losses, reported together from the admin UI:
 *
 *   1. It refused to even ask some providers. `anthropic`, `azure` and
 *      `custom-openai` were on a hardcoded list that returned "not supported"
 *      *without calling anything*. That is a claim about the vendor made on the
 *      vendor's behalf, and it is usually wrong: a `custom-openai` provider is
 *      normally an OpenAI-compatible gateway with a working /v1/models. The
 *      same route also *assumed* support and printed a result nobody checked.
 *      Neither is a measurement. Now it asks both candidate paths and reports
 *      the HTTP status it actually got.
 *
 *   2. When it did get a list, it kept the id and threw the rest away. Most
 *      upstreams publish only an id — but some publish a context window and an
 *      output cap, and discarding those meant the operator was asked to type
 *      numbers the vendor had already stated. "Most parameters should come from
 *      the provider config" is a request, and a fetch that drops what the
 *      provider said is the reason it could not be honoured.
 *
 * Both halves are asserted here. The unit tests pin the parsing and the merge;
 * the source assertions pin the parts that are structural (which paths get
 * tried, what the response carries) and would be awkward to exercise through
 * the route's admin-authenticated request.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractModelEntries, extractModelIds } from "@/lib/providers/upstream";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  mergeFetchedModels,
} from "@/app/(admin)/admin/providers/model-rows";

const ROOT = process.cwd();
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), "utf-8");
const PROBE = read("src", "app", "api", "admin", "providers", "probe", "route.ts");
const BUTTON = read(
  "src", "app", "(admin)", "admin", "providers", "CreateProviderButton.tsx",
);
const CATALOG_VIEW = read("src", "components", "docs", "ModelCatalog.tsx");

describe("reading what the upstream actually said about a model", () => {
  it("keeps the context window and the output cap, not just the id", () => {
    const [entry] = extractModelEntries({
      data: [{ id: "claude-sonnet", context_length: 200000, max_output_tokens: 64000 }],
    });
    expect(entry).toEqual({
      id: "claude-sonnet",
      contextLength: 200000,
      maxOutputTokens: 64000,
    });
  });

  it("reads the spellings that are actually in the wild", () => {
    // OpenRouter publishes context_length; the OpenAI-compatible gateways tend
    // to publish max_context_tokens / max_completion_tokens; a few publish the
    // window as a string. Pinning one spelling would make this a
    // single-vendor feature, which is the mistake being corrected.
    expect(extractModelEntries([{ id: "a", max_context_tokens: 32000 }])[0].contextLength).toBe(32000);
    expect(
      extractModelEntries([{ id: "a", max_completion_tokens: 4096 }])[0].maxOutputTokens,
    ).toBe(4096);
    expect(extractModelEntries([{ id: "a", context_window: 8000 }])[0].contextLength).toBe(8000);
    // JSON is untyped in practice; "200000" is a window, not junk.
    expect(extractModelEntries([{ id: "a", context_length: "200000" }])[0].contextLength).toBe(200000);
  });

  it("invents nothing when the vendor published nothing", () => {
    // The one behaviour that must not move: a missing field stays missing. A
    // default filled in here would be stored as though the operator had chosen
    // it, and the docs would print a guess as a fact.
    expect(extractModelEntries([{ id: "bare" }])).toEqual([{ id: "bare" }]);
    expect(extractModelEntries([{ id: "bare" }])[0].contextLength).toBeUndefined();
  });

  it("refuses a number that is not one", () => {
    for (const bad of [0, -5, "abc", "", null, {}]) {
      const entry = extractModelEntries([{ id: "m", context_length: bad }])[0];
      expect(entry.contextLength, `accepted ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("still accepts a bare list of ids, from either wrapper", () => {
    expect(extractModelEntries(["a", "  b  "])).toEqual([{ id: "a" }, { id: "b" }]);
    expect(extractModelEntries({ models: [{ id: "m" }] })).toEqual([{ id: "m" }]);
    expect(extractModelEntries(null)).toEqual([]);
    expect(extractModelEntries({ data: "not a list" })).toEqual([]);
  });

  it("keeps what it did not recognise instead of dropping it", () => {
    const [entry] = extractModelEntries([{ id: "m", owned_by: "acme", modality: "text" }]);
    expect(entry.extra).toEqual({ owned_by: "acme", modality: "text" });
  });

  it("extractModelIds still returns ids, for the callers that only want those", () => {
    expect(
      extractModelIds({ data: [{ id: "a", context_length: 5 }, "b"] }),
    ).toEqual(["a", "b"]);
  });
});

describe("merging what came back into the editor's rows", () => {
  it("the vendor's own window lands in the row", () => {
    const rows = mergeFetchedModels([], [
      { id: "claude", contextLength: 200000, maxOutputTokens: 64000 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].contextLength).toBe(200000);
    expect(rows[0].maxOutputTokens).toBe(64000);
    expect(rows[0].clientId).toBe("claude");
    expect(rows[0].upstreamId).toBe("claude");
  });

  it("a silent vendor leaves the library defaults, not a zero and not a guess", () => {
    // 0 is "a model with no window at all" and would be stored as a decision.
    const rows = mergeFetchedModels([], ["plain", { id: "also-plain" }]);
    for (const row of rows) {
      expect(row.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
      expect(row.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }
  });

  it("the template's defaults still apply, and the entry outranks them", () => {
    const withDefault = mergeFetchedModels([], [{ id: "m" }], {
      contextLength: 999,
      maxOutputTokens: 111,
    });
    expect(withDefault[0].contextLength).toBe(999);
    expect(withDefault[0].maxOutputTokens).toBe(111);

    const withFacts = mergeFetchedModels([], [{ id: "m", contextLength: 4 }], {
      contextLength: 999,
    });
    expect(withFacts[0].contextLength).toBe(4);
  });

  it("does not re-add a model the operator already has", () => {
    // Both spellings count as "already have it": the row is keyed by the client
    // id, but the upstream may have called the same model something else, and
    // matching on either one avoids the duplicate row.
    const existing = {
      id: "r", clientId: "mine", upstreamId: "theirs",
      contextLength: 1, maxOutputTokens: 2, inputCost: 0, outputCost: 0,
    };
    const rows = mergeFetchedModels([existing], ["mine", "theirs", "new-one"]);
    // The existing row is returned untouched, and only the genuinely new model
    // is appended — no second "mine", no second "theirs".
    expect(rows.map((r) => r.clientId)).toEqual(["mine", "new-one"]);
    expect(rows[0]).toBe(existing);
  });
});

describe("the probe asks, rather than deciding in advance", () => {
  it("no provider kind is refused without being called", () => {
    // Anchored to the code form, not the words: the comment above it names all
    // three kinds on purpose, and a bare /anthropic/ assertion would match that
    // paragraph and pass on the bug it is meant to catch.
    expect(PROBE, "a kind is still deciding whether to ask").not.toMatch(/body\.kind\s*===/);
    expect(PROBE, "a kind is still deciding whether to ask").not.toMatch(
      /if\s*\(\s*\["anthropic",\s*"azure",\s*"custom-openai"\]\s*\.includes\(/,
    );
  });

  it("both candidate paths are tried, in order", () => {
    expect(PROBE).toMatch(/const CANDIDATE_PATHS = \["\/v1\/models", "\/models"\];/);
  });

  it("an empty list reports what it tried and what each path answered", () => {
    // "Not supported" was a guess. An HTTP status is a measurement, and it is
    // the only one the operator can act on.
    expect(PROBE).toMatch(/attempted/);
    expect(PROBE).toMatch(/HTTP \$\{a\.status\}/);
  });

  it("both branches return whole entries, so a hand-typed path is not a downgrade", () => {
    // The notice above tells an operator whose vendor has no /v1/models to put
    // the address in the path field. That branch used to go through
    // extractModelIds and return bare ids — losing the very fields the notice
    // sends them there to get.
    expect(PROBE).toMatch(/const entries = extractModelEntries\(result\.body\)/);
    expect(PROBE).toMatch(/models: entries,/);
    expect(PROBE, "the hand-typed path still returns bare ids").not.toMatch(/extractModelIds\(/);
  });

  it("the client keeps the entries and shows the notice", () => {
    expect(BUTTON).toMatch(/models\?: Array<string \| \{ id: string;/);
    expect(BUTTON, "an empty fetch says nothing").toMatch(/data\.notice/);
  });
});

describe("the price columns say what they are", () => {
  it("all four rates are named, and each carries its own unit", () => {
    // The report was "入 250  出 1000  命中缓存 25" — three numbers, no units, no
    // way to tell a rate from a total. The fix is a column per rate with the
    // unit in the header, so a reader never has to infer either.
    for (const key of [
      "docs.catalog.rateIn",
      "docs.catalog.rateOut",
      "docs.catalog.rateCachedRead",
      "docs.catalog.rateCachedWrite",
    ]) {
      expect(CATALOG_VIEW, `${key} has no column`).toMatch(
        new RegExp(`\\{t\\("${key}"\\)\\}[\\s\\S]{0,200}?\\{t\\("docs\\.catalog\\.perMillion"\\)\\}`),
      );
    }
    expect(CATALOG_VIEW, "the media price lost its unit").toMatch(/docs\.catalog\.perItem/);
  });

  it("the cache columns read the configured rate", () => {
    // The write column was a hardcoded dash: a column that can never answer.
    // Both now read the rate, and both treat unset as "priced as the input".
    expect(CATALOG_VIEW).toMatch(/m\.cachedInputCost === null \? cost\(null\) : cost\(m\.cachedInputCost\)/);
    expect(CATALOG_VIEW, "the cache-write cell is still a constant").toMatch(
      /m\.cacheWriteCost === null \? cost\(null\) : cost\(m\.cacheWriteCost\)/,
    );
  });

  it("the detail row spans the row it belongs to", () => {
    // chat: model + provider + context + max output + 4 rates + action = 9.
    // media: model + provider + kind + endpoint + 1 price + action = 6.
    expect(CATALOG_VIEW).toMatch(/colSpan=\{isChat \? 9 : 6\}/);
  });
});
