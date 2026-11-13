/**
 * tests/unit/request-limits.test.ts
 *
 * The time a request may take, and who decides it.
 *
 * RelayAB relays to vendors it does not control, so the vendor's own window is
 * the only deadline that matters. Everything else in the chain is a guard:
 *
 *   - `MAX_SPEC_TIMEOUT_MS` catches `600` written where seconds were meant;
 *   - `HOST_IDLE_TIMEOUT_MS` is what the proxy resets on activity (not a total);
 *   - `HEARTBEAT_INTERVAL_MS` is what keeps that idle timer from expiring;
 *   - `CONNECT_TIMEOUT_MS` fails a dead host fast.
 *
 * The bug this replaces: four numbers typed separately (300000 / 240000 /
 * `maxDuration = 300` / nginx 600s) drifted apart, a spec allowed 300s was
 * aborted at 240s, and undici's own 300s default killed anything slower than five
 * minutes with a message that read like "upstream timeout" (2026-11-13).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_SPEC_TIMEOUT_MS,
  HEARTBEAT_AFTER_MS,
  HEARTBEAT_INTERVAL_MS,
  HOST_IDLE_TIMEOUT_MS,
  MAX_SPEC_TIMEOUT_MS,
} from "@/lib/protocol/limits";

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("the guards sit around the vendor's window, not inside it", () => {
  it("the sanity bound is nowhere near a real vendor window", () => {
    // If this ever drops back towards a few minutes it will start rejecting
    // specs that are simply describing a slow vendor — the 300000 mistake.
    expect(MAX_SPEC_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000_000);
    expect(DEFAULT_SPEC_TIMEOUT_MS).toBeLessThan(MAX_SPEC_TIMEOUT_MS);
  });

  it("the proxy's idle window is longer than any spec may ask for", () => {
    // nginx measures idle time, and the heartbeat keeps it fed; but a spec that
    // ran longer than the window with no traffic at all would still be cut.
    expect(HOST_IDLE_TIMEOUT_MS).toBeGreaterThan(MAX_SPEC_TIMEOUT_MS);
  });

  it("the heartbeat is well inside the idle window", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    // A beat has to be able to happen before the response commits to streaming.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(HEARTBEAT_AFTER_MS);
    // And many of them fit inside the proxy's idle window.
    expect(HEARTBEAT_INTERVAL_MS * 4).toBeLessThan(HOST_IDLE_TIMEOUT_MS);
  });

  it("connecting stays bounded, so a dead host fails fast", () => {
    expect(CONNECT_TIMEOUT_MS).toBeLessThan(DEFAULT_SPEC_TIMEOUT_MS);
  });
});

describe("the transport does not invent a deadline", () => {
  it("installs an undici agent with header/body timers disabled", () => {
    // Node's `fetch` ships 300s `headersTimeout`/`bodyTimeout`. They are not the
    // vendor's limit and not ours — they were a library default silently killing
    // long generations, and the failure looked like an upstream timeout.
    const src = read("src", "lib", "http", "transport.ts");
    expect(src).toContain("headersTimeout: 0");
    expect(src).toContain("bodyTimeout: 0");
    expect(src).toContain("setGlobalDispatcher");
  });

  it("is installed when the server starts", () => {
    const src = read("src", "instrumentation.ts");
    expect(src).toContain("installTransportTimeouts");
  });
});

describe("no route invents a request deadline of its own", () => {
  it.each([
    ["images", "generations"],
    ["images", "edits"],
    ["videos", "generations"],
    ["audio", "transcriptions"],
    ["audio", "translations"],
  ])("the %s/%s route has no literal abort or platform duration", (...parts) => {
    const src = read("src", "app", "api", "v1", ...parts, "route.ts");
    expect(src).not.toMatch(/maxDuration\s*=\s*\d+/);
    expect(src).not.toMatch(/AbortSignal\.timeout\(\s*\d{3,}/);
  });

  it("the assistant media test derives nothing from a fixed budget", () => {
    const src = read("src", "app", "api", "assistant", "test-media", "route.ts");
    expect(src).not.toMatch(/AbortSignal\.timeout\(\s*\d{3,}/);
    expect(src).not.toContain("REQUEST_BUDGET_MS");
  });

  it("the validator derives its bound from the constant", () => {
    const src = read("src", "lib", "media", "spec.ts");
    expect(src).toContain("MAX_SPEC_TIMEOUT_MS");
    expect(src).not.toMatch(/300_000/);
  });
});

describe("slow JSON answers keep the connection alive", () => {
  it("the media routes that can run for minutes heartbeat", () => {
    for (const [dir, name] of [
      ["images", "generations"],
      ["images", "edits"],
      ["videos", "generations"],
    ] as const) {
      expect(read("src", "app", "api", "v1", dir, name, "route.ts")).toContain(
        "respondWithHeartbeat",
      );
    }
  });

  it("and text-to-speech does not, because whitespace would corrupt the audio", () => {
    const src = read("src", "app", "api", "assistant", "test-media", "route.ts");
    expect(src).toContain('jsonCapability === "audio.tts" ? work : respondWithHeartbeat(work)');
  });
});
