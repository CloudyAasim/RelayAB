/**
 * tests/unit/provider-reasoning-levels.test.ts
 *
 * Reading what a vendor says about a model's thinking levels, and carrying it
 * to where it is useful.
 *
 * The report this answers is that the levels belong to the model: four on one
 * vendor, three on the next, an off switch on a third, nothing at all on a model
 * that does not think. So the whole chain has to survive a list nobody here
 * chose, and — the part that matters most — has to stay *empty* when the vendor
 * said nothing. A default of four is a list that is wrong for most models here
 * and wrong silently, which is exactly what the earlier fixed list was.
 */
import { describe, it, expect } from "vitest";
import { extractModelEntries } from "@/lib/providers/upstream";
import {
  newModelRow,
  mergeFetchedModels,
  rowsFromProvider,
  rowsToPayload,
} from "@/app/(admin)/admin/providers/model-rows";

describe("reading the levels a vendor publishes", () => {
  it("takes a plain list", () => {
    const [entry] = extractModelEntries([
      { id: "m", supported_reasoning_efforts: ["low", "medium", "high"] },
    ]);
    expect(entry.reasoningLevels).toEqual(["low", "medium", "high"]);
  });

  it("and the nested shape, and the enum wrapper", () => {
    // Three shapes, three vendors, one reader. Missing any of them means the
    // operator types the list instead.
    expect(
      extractModelEntries([{ id: "m", reasoning: { effort: ["low", "high"] } }])[0]
        .reasoningLevels,
    ).toEqual(["low", "high"]);
    expect(
      extractModelEntries([{ id: "m", thinking: { levels: ["minimal", "max"] } }])[0]
        .reasoningLevels,
    ).toEqual(["minimal", "max"]);
    expect(
      extractModelEntries([
        { id: "m", reasoning_efforts: { enum: ["a", "b"] } },
      ])[0].reasoningLevels,
    ).toEqual(["a", "b"]);
    // An effort written as an object, which some catalogues do.
    expect(
      extractModelEntries([
        { id: "m", supported_efforts: [{ effort: "high" }, { name: "low" }] },
      ])[0].reasoningLevels,
    ).toEqual(["high", "low"]);
  });

  it("and says nothing when the vendor said nothing", () => {
    // The load-bearing case. A model that does not think publishes no levels,
    // and inventing four is the mistake this whole path exists to avoid.
    expect(extractModelEntries([{ id: "m" }])[0].reasoningLevels).toBeUndefined();
    expect(extractModelEntries([{ id: "m", reasoning: {} }])[0].reasoningLevels).toBeUndefined();
    // An empty list is not a list.
    expect(
      extractModelEntries([{ id: "m", supported_reasoning_efforts: [] }])[0].reasoningLevels,
    ).toBeUndefined();
  });

  it("without swallowing the rest of the entry", () => {
    // The levels must not become `extra` noise, and reading them must not cost
    // the operator the fields that were already being read.
    const [entry] = extractModelEntries([
      {
        id: "m",
        context_length: 200000,
        max_output_tokens: 8192,
        supported_reasoning_efforts: ["low", "high"],
        owned_by: "acme",
      },
    ]);
    expect(entry.contextLength).toBe(200000);
    expect(entry.maxOutputTokens).toBe(8192);
    expect(entry.reasoningLevels).toEqual(["low", "high"]);
    expect(entry.extra).toEqual({ owned_by: "acme" });
  });

  it("and does not repeat a level twice", () => {
    expect(
      extractModelEntries([{ id: "m", supported_reasoning_efforts: ["low", "low", "high"] }])[0]
        .reasoningLevels,
    ).toEqual(["low", "high"]);
  });
});

describe("carrying them into the row the operator saves", () => {
  it("a fetched model keeps the levels its vendor published", () => {
    const [row] = mergeFetchedModels([], [
      { id: "m", contextLength: 200000, reasoningLevels: ["low", "high"] },
    ]);
    expect(row.reasoningLevels).toEqual(["low", "high"]);
  });

  it("a model whose vendor said nothing keeps an empty list, never four", () => {
    const [row] = mergeFetchedModels([], [{ id: "m" }]);
    expect(row.reasoningLevels).toEqual([]);
    expect(newModelRow().reasoningLevels).toEqual([]);
  });

  it("and they survive the round trip out to storage", () => {
    const rows = mergeFetchedModels([], [
      { id: "m", reasoningLevels: ["low", "medium", "high"] },
    ]);
    const { modelConfigs } = rowsToPayload(rows);
    expect(modelConfigs.m.reasoningLevels).toEqual(["low", "medium", "high"]);
  });

  it("and back in again, so the editor does not forget them on a re-open", () => {
    const [row] = rowsFromProvider(
      { m: "m" },
      { m: { upstreamId: "m", contextLength: 128000, maxOutputTokens: 8192, reasoningLevels: ["high"] } },
    );
    expect(row.reasoningLevels).toEqual(["high"]);
  });
});
