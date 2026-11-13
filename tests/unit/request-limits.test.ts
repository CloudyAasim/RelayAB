/**
 * tests/unit/request-limits.test.ts
 *
 * The request budget lives in one file (`src/lib/protocol/limits.ts`), and this
 * guard keeps it there.
 *
 * Why it matters: on 2026-11-13 two symptoms had the same cause — the numbers
 * were typed into every layer separately and had drifted apart. A spec allowed
 * 300s was aborted by its own route at 240s, and the protocol document quoted a
 * "serverless ceiling" that had not existed since the deployment left Vercel.
 * RelayAB is a relay for many vendors: the values will change again, and only
 * the *ordering* below is permanent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SPEC_TIMEOUT_MS,
  HOST_REQUEST_CEILING_MS,
  MAX_SPEC_TIMEOUT_MS,
  REQUEST_BUDGET_MS,
} from "@/lib/protocol/limits";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("the layers, in the order they fire", () => {
  it("spec timeout ≤ spec default ceiling < route abort < host allowance", () => {
    // The spec's deadline must fire first (it can say something vendor-specific
    // and lands in the error envelope); the route is the backstop; nginx is the
    // floor we must stay above or the client gets a connection error instead.
    expect(DEFAULT_SPEC_TIMEOUT_MS).toBeLessThanOrEqual(MAX_SPEC_TIMEOUT_MS);
    expect(MAX_SPEC_TIMEOUT_MS).toBeLessThan(REQUEST_BUDGET_MS);
    expect(REQUEST_BUDGET_MS).toBeLessThan(HOST_REQUEST_CEILING_MS);
  });

  it("the host's declared allowance really is at least as large", () => {
    const nginx = read("deploy", "nginx.conf");
    const explicit = /proxy_read_timeout\s+(\d+)s/.exec(nginx);
    expect(explicit, "nginx must declare proxy_read_timeout").toBeTruthy();
    expect(Number(explicit![1]) * 1000).toBeGreaterThanOrEqual(REQUEST_BUDGET_MS);
  });
});

describe("no layer types the number again", () => {
  it.each([
    ["images/generations"],
    ["images/edits"],
    ["audio/transcriptions"],
    ["audio/translations"],
  ])("the %s route has no platform duration and no literal abort", (...parts) => {
    const src = read("src", "app", "api", "v1", ...parts, "route.ts");
    // `maxDuration` is a Vercel declaration; this deployment is a Dokku
    // container, and four routes declaring 300 while honouring something else is
    // how the drift started.
    expect(src).not.toMatch(/maxDuration\s*=\s*\d+/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(\s*\d{3,}/);
  });

  it("the assistant media test derives its abort from the budget", () => {
    const src = read("src", "app", "api", "assistant", "test-media", "route.ts");
    expect(src).toContain("REQUEST_BUDGET_MS");
    expect(src).not.toMatch(/AbortSignal\.timeout\(\s*\d{3,}/);
  });

  it("the validator derives its ceiling from the same constant", () => {
    const src = read("src", "lib", "media", "spec.ts");
    expect(src).toContain("MAX_SPEC_TIMEOUT_MS");
    expect(src).not.toMatch(/300_000/);
  });

  it("upload ceilings come from the same file", () => {
    expect(read("src", "app", "api", "v1", "audio", "transcriptions", "route.ts")).toContain(
      "MAX_AUDIO_UPLOAD_BYTES",
    );
    expect(read("src", "app", "api", "v1", "images", "edits", "route.ts")).toContain(
      "MAX_IMAGE_UPLOAD_BYTES",
    );
  });
});
