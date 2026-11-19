/**
 * tests/unit/announcement-dismissal.test.ts
 *
 * Which announcements this browser has already closed.
 *
 * A dismissal is a per-browser reading preference and it lives in
 * localStorage, which fails in more ways than one: private mode refuses the
 * write, a hand-edited value is not JSON, and the stored list grows for ever
 * unless something prunes it. Every one of those failures has to land on the
 * *safe* side — a notice shown once more — because the other direction hides
 * something the operator published.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { parseDismissed } from "@/lib/announcements/dismissal";

describe("parsing what was stored", () => {
  it("reads a list of ids", () => {
    expect(parseDismissed('["a","b"]')).toEqual(["a", "b"]);
  });

  it("reads nothing when there is nothing", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed(undefined)).toEqual([]);
    expect(parseDismissed("")).toEqual([]);
  });

  it("reads a corrupt value as nothing dismissed, not as an error", () => {
    // The page must render; a dismissal list that cannot be read is a notice
    // shown again, which cannot hide anything.
    expect(parseDismissed("{not json")).toEqual([]);
    expect(parseDismissed('"a string"')).toEqual([]);
    expect(parseDismissed("42")).toEqual([]);
  });

  it("drops the entries that are not ids, and keeps the ones that are", () => {
    expect(parseDismissed('["a", 3, null, "", true, "b"]')).toEqual(["a", "b"]);
  });
});

describe("reading and writing through storage", () => {
  const KEY = "relayab-announcements-dismissed";
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips an id", async () => {
    const { readDismissedIds, writeDismissedIds } = await import(
      "@/lib/announcements/dismissal"
    );
    writeDismissedIds(["ann_1"]);
    expect(store.get(KEY)).toBe('["ann_1"]');
    expect(readDismissedIds()).toEqual(["ann_1"]);
  });

  it("keeps only the newest few hundred, because nothing else prunes the list", async () => {
    const { readDismissedIds, writeDismissedIds } = await import(
      "@/lib/announcements/dismissal"
    );
    const many = Array.from({ length: 250 }, (_, i) => `ann_${i}`);
    writeDismissedIds(many);
    const kept = readDismissedIds();
    expect(kept).toHaveLength(200);
    // The tail: the most recent dismissals are the ones still worth knowing.
    expect(kept[kept.length - 1]).toBe("ann_249");
  });

  it("reports nothing dismissed when storage refuses to be read", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {},
      },
    });
    const { readDismissedIds } = await import("@/lib/announcements/dismissal");
    expect(readDismissedIds()).toEqual([]);
  });

  it("swallows a refused write, so closing a banner cannot break the page", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    const { writeDismissedIds } = await import("@/lib/announcements/dismissal");
    expect(() => writeDismissedIds(["a"])).not.toThrow();
  });

  it("does nothing on the server, where there is no window", async () => {
    vi.unstubAllGlobals();
    const { readDismissedIds, writeDismissedIds } = await import(
      "@/lib/announcements/dismissal"
    );
    expect(readDismissedIds()).toEqual([]);
    expect(() => writeDismissedIds(["a"])).not.toThrow();
  });
});