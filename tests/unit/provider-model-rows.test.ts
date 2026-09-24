/**
 * Model-row editing — the data layer behind the provider create form and the
 * edit modal.
 *
 * Regression context (reported from the admin UI):
 *   1. typing in the client model id lost focus after every keystroke, because
 *      the row's React key *was* the value being edited;
 *   2. the edit modal could not set the context window, output cap or credit
 *      cost at all — it only edited upstream→client mappings, and the PATCH
 *      route did not even accept `modelConfigs`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_OUTPUT_TOKENS,
  duplicateClientIds,
  mergeFetchedModels,
  newModelRow,
  rowsFromProvider,
  rowsToPayload,
} from "@/app/(admin)/admin/providers/model-rows";

const SRC = join(__dirname, "..", "..", "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf-8");

describe("rowsFromProvider", () => {
  it("loads the mapping together with its per-model config", () => {
    const rows = rowsFromProvider(
      { "gpt-4o": "gpt-4o-2024-08-06" },
      {
        "gpt-4o": {
          upstreamId: "gpt-4o-2024-08-06",
          contextLength: 200000,
          maxOutputTokens: 16384,
          inputCost: 12,
          outputCost: 34,
        },
      },
    );
    expect(rows).toEqual([
      {
        id: "saved-0",
        clientId: "gpt-4o",
        upstreamId: "gpt-4o-2024-08-06",
        contextLength: 200000,
        maxOutputTokens: 16384,
        inputCost: 12,
        outputCost: 34,
      },
    ]);
  });

  it("falls back to library defaults for a mapping with no config yet", () => {
    const [row] = rowsFromProvider({ "gpt-4o": "gpt-4o-2024-08-06" }, {});
    expect(row.contextLength).toBe(DEFAULT_CONTEXT_LENGTH);
    expect(row.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(row.inputCost).toBe(0);
  });

  it("gives rows ids that do not depend on the client model id", () => {
    // The id is what React keys on; deriving it from the editable client id is
    // the bug this replaced.
    const [row] = rowsFromProvider({ "gpt-4o": "up" }, {});
    expect(row.id).not.toContain("gpt-4o");
  });
});

describe("rowsToPayload", () => {
  it("keeps mapping and config in step", () => {
    const rows = [
      newModelRow({
        clientId: "gpt-4o",
        upstreamId: "gpt-4o-2024-08-06",
        contextLength: 200000,
        maxOutputTokens: 16384,
        inputCost: 12,
        outputCost: 34,
      }),
    ];
    const { modelMapping, modelConfigs } = rowsToPayload(rows);
    expect(modelMapping).toEqual({ "gpt-4o": "gpt-4o-2024-08-06" });
    expect(modelConfigs["gpt-4o"]).toEqual({
      clientId: "gpt-4o",
      upstreamId: "gpt-4o-2024-08-06",
      enabled: true,
      contextLength: 200000,
      maxOutputTokens: 16384,
      inputCost: 12,
      outputCost: 34,
    });
  });

  it("trims ids and skips half-filled rows", () => {
    const { modelMapping } = rowsToPayload([
      newModelRow({ clientId: "  spaced  ", upstreamId: "  up  " }),
      newModelRow({ clientId: "no-upstream", upstreamId: "" }),
      newModelRow({ clientId: "", upstreamId: "no-client" }),
    ]);
    expect(modelMapping).toEqual({ spaced: "up" });
  });

  it("omits blank numeric fields so the schema defaults apply", () => {
    // Clearing a number input yields 0; forwarding that would fail
    // `ModelConfigSchema`'s positive() checks on contextLength/maxOutputTokens.
    const { modelConfigs } = rowsToPayload([
      newModelRow({ clientId: "m", upstreamId: "up", contextLength: 0, maxOutputTokens: 0 }),
    ]);
    expect(modelConfigs.m).toEqual({ clientId: "m", upstreamId: "up", enabled: true });
  });

  it("lets the last row win when a client model id is duplicated", () => {
    const { modelMapping } = rowsToPayload([
      newModelRow({ clientId: "dup", upstreamId: "first" }),
      newModelRow({ clientId: "dup", upstreamId: "second" }),
    ]);
    expect(modelMapping).toEqual({ dup: "second" });
  });
});

describe("duplicateClientIds", () => {
  it("reports only ids claimed more than once", () => {
    expect(
      duplicateClientIds([
        newModelRow({ clientId: "a" }),
        newModelRow({ clientId: "b" }),
        newModelRow({ clientId: "a" }),
      ]),
    ).toEqual(["a"]);
  });

  it("ignores empty rows", () => {
    expect(duplicateClientIds([newModelRow(), newModelRow()])).toEqual([]);
  });
});

describe("mergeFetchedModels", () => {
  it("adds unknown ids as identity mappings and keeps existing rows", () => {
    const rows = [newModelRow({ clientId: "existing", upstreamId: "up" })];
    const merged = mergeFetchedModels(rows, ["existing", "new-one"]);
    expect(merged.map((r) => r.clientId)).toEqual(["existing", "new-one"]);
    expect(merged[1].upstreamId).toBe("new-one");
  });

  it("does not re-add an id already used as an upstream name", () => {
    const rows = [newModelRow({ clientId: "alias", upstreamId: "real-model" })];
    expect(mergeFetchedModels(rows, ["real-model"])).toHaveLength(1);
  });

  it("applies caller defaults to the new rows", () => {
    const merged = mergeFetchedModels([], ["m"], { contextLength: 4096 });
    expect(merged[0].contextLength).toBe(4096);
  });
});

describe("UI invariants for the model editor", () => {
  const editor = read("app/(admin)/admin/providers/ProviderModelsEditor.tsx");

  it("keys rows by the row id, never by the editable client model id", () => {
    expect(editor).toContain("key={row.id}");
    expect(editor).not.toMatch(/key=\{(client|row\.clientId)\}/);
  });

  it("renders every config column the schema stores", () => {
    for (const field of ["contextLength", "maxOutputTokens", "inputCost", "outputCost"]) {
      expect(editor).toContain(`["${field}"`);
    }
  });
});

describe("the edit modal persists model configs", () => {
  it("sends mapping + configs built from the same rows", () => {
    const modal = read("app/(admin)/admin/providers/ProviderActions.tsx");
    expect(modal).toContain("...rowsToPayload(modelRows)");
    expect(modal).toContain("rowsFromProvider(provider.modelMapping, provider.modelConfigs)");
  });

  it("lets PATCH accept modelConfigs", () => {
    const route = read("app/api/admin/providers/[id]/route.ts");
    expect(route).toContain("modelConfigs:");
    expect(route).toContain("contextLength");
    expect(route).toContain("inputCost");
  });
});
