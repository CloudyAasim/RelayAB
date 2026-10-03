/**
 * tests/unit/next-config-build-cpus.test.ts
 *
 * `experimental.cpus` is a memory ceiling, not a tuning knob.
 *
 * The production host has 3.8 GiB of RAM and no swap. Left to itself Next.js
 * sizes its static-generation worker pool from the CPU count and spawns one
 * Node process per core minus one, so peak build memory follows the host's
 * core count: measured here, 15 workers peak at 2491.8 MiB against ~1.7 GiB
 * for 1–3 workers. The cliff is above three, not at it.
 *
 * `NEXT_BUILD_CPUS` exists so the host operator can turn it down without a
 * code change. That makes the fallback the part worth testing: a typo in the
 * environment (`""`, `"two"`, a stray `0`) must land on the safe default
 * rather than hand Next.js `undefined`, which silently restores the
 * core-derived worker count and puts the host back where it started.
 */
import { describe, it, expect, vi } from "vitest";

async function loadCpus(value: string | undefined): Promise<unknown> {
  const previous = process.env.NEXT_BUILD_CPUS;
  if (value === undefined) {
    delete process.env.NEXT_BUILD_CPUS;
  } else {
    process.env.NEXT_BUILD_CPUS = value;
  }
  try {
    vi.resetModules();
    const mod = await import("../../next.config.mjs");
    return mod.default.experimental?.cpus;
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_BUILD_CPUS;
    } else {
      process.env.NEXT_BUILD_CPUS = previous;
    }
  }
}

describe("next.config build worker count", () => {
  it("caps the worker pool at 2 when nothing is set", async () => {
    // The default matters most: an unset variable must not mean "however many
    // cores this box happens to have".
    expect(await loadCpus(undefined)).toBe(2);
  });

  it("honours an explicit override from the environment", async () => {
    expect(await loadCpus("1")).toBe(1);
    expect(await loadCpus("4")).toBe(4);
  });

  it("falls back to 2 rather than degrading to undefined", async () => {
    // Each of these used to be a way to silently turn the ceiling off.
    for (const bad of ["", "  ", "two", "0", "-3", "1.5.2"]) {
      expect(await loadCpus(bad)).toBe(2);
    }
  });

  it("always yields a positive integer", async () => {
    // Guards the shape itself, not just the chosen value: Next.js treats a
    // non-integer `cpus` as "not specified" and re-derives it from the CPU
    // count, which is the exact outcome these tests exist to prevent.
    for (const value of [undefined, "", "0", "1", "2", "3", "8", "nope"]) {
      const cpus = (await loadCpus(value)) as number;
      expect(Number.isInteger(cpus)).toBe(true);
      expect(cpus).toBeGreaterThan(0);
    }
  });
});
