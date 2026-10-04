/**
 * tests/unit/refusal-text.test.ts
 *
 * `callUpstream` fills `body` for a response that came back and said no, and
 * `error` only for a request that never got an answer. They are not
 * interchangeable, and nothing about the type says so: both are optional.
 *
 * The detector read `error`. On a 400 that is `undefined`, every time, so it
 * reported "this vendor publishes nothing" for every vendor, permanently — and
 * the one time it could have been caught, it was: pressing the button said
 * "asked 9 models, learned nothing", while the same vendor's enumeration was
 * sitting in `body`, unread, on the same object.
 */
import { describe, it, expect } from "vitest";
import { refusalText, type UpstreamFetchResult } from "@/lib/providers/upstream";
import { refusalVocabulary } from "@/lib/assistant/detect-levels";

/** What `callUpstream` actually returns for a 400 — no `error` at all. */
const REFUSAL: UpstreamFetchResult = {
  ok: false,
  status: 400,
  body: {
    error: {
      message:
        'invalid params, invalid reasoning_effort: "__relayab_not_a_level__" (allowed: low, medium, high, xhigh, max) (2013)',
    },
  },
  latencyMs: 12,
};

describe("where an upstream refusal actually is", () => {
  it("is in `body`, and `error` is absent on a response that arrived", () => {
    // Stated as a fact about the shape, because the whole bug was a wrong
    // belief about it. If this ever changes, this test is what should break.
    expect(REFUSAL.body).toBeDefined();
    expect(REFUSAL.error).toBeUndefined();
  });

  it("and reading it yields the vocabulary the detector needs", () => {
    const said = refusalText(REFUSAL.body);
    expect(refusalVocabulary(said)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("while reading the field that is not there yields nothing, as it always did", () => {
    // Kept as an assertion rather than a comment: this is the exact pair of
    // expressions the route used, and the one that made it look like a vendor
    // that publishes nothing.
    const said = (REFUSAL.error ?? "").slice(0, 600);
    expect(said).toBe("");
    expect(refusalVocabulary(said)).toBeNull();
  });

  it("and a network failure, which is the other thing, still reads as one", () => {
    // `error` is not useless — it is the *other* case. A request that never got
    // an answer has no body, and the detector must treat that as "did not
    // answer" rather than as a refusal about a level.
    const failed: UpstreamFetchResult = {
      ok: false,
      status: 0,
      error: "fetch failed",
      latencyMs: 5,
    };
    expect(refusalText(failed.body)).toBe("");
    expect(refusalVocabulary(refusalText(failed.body))).toBeNull();
  });

  it("and it survives whatever shape the body arrives in", () => {
    expect(refusalText("plain text")).toBe("plain text");
    expect(refusalText(undefined)).toBe("");
    expect(refusalText(null)).toBe("");
    expect(() => refusalText({ circular: true })).not.toThrow();
  });
});

describe("the route reads the field that is there", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const route = fs.readFileSync("src/app/api/assistant/refresh-models/route.ts", "utf-8");

  it("not the one that is not", () => {
    // Source-shaped because the failure was a source-level mistake that no
    // type or test caught: both fields are optional, so the wrong one
    // compiles perfectly and fails silently forever.
    expect(route, "the ask still reads `error`").not.toMatch(/refusalText\(r\.error\)/);
    expect(route, "the ask does not read `body`").toContain("refusalText(r.body)");
    expect(route, "the ask never reads `.error` on a response").not.toMatch(
      /\(r\.error \?\? ""\)/,
    );
  });

  it("and there is only one detector left", () => {
    // Two implementations of one thing is how they drifted apart in the first
    // place, and the second one had no button.
    expect(fs.existsSync("src/app/api/admin/model-config/detect-levels")).toBe(false);
  });
});
