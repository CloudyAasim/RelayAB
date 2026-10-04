/**
 * tests/unit/upstream-refusal-message.test.ts
 *
 * The vendor's own words, in the client's error.
 *
 * `Upstream returned 400` tells a caller that something failed and nothing about
 * what. The body was read, logged and filed, then dropped on the floor — and
 * the body is the only place a vendor says *why*: which values a parameter
 * accepts, what it calls one, whether a field exists at all here.
 *
 * Found with a real key against MiniMax: an invalid `reasoning_effort` came back
 * as a 502 wrapping "Upstream returned 400", with the enumeration the detector
 * needs sitting in a `console.error` nobody reads. Every check below is against
 * the shapes a real vendor produces, plus the ones that must not get through.
 */
import { describe, it, expect } from "vitest";
import { upstreamRefusal } from "@/lib/proxy/openai";

describe("what the client is told when the vendor refuses", () => {
  it("carries the vendor's message, which is the only place the answer is", () => {
    // The real shape, from MiniMax: a JSON error whose message enumerates.
    const body = JSON.stringify({
      error: {
        message:
          "Invalid value for 'reasoning_effort': must be one of \"minimal\", \"low\", \"medium\", \"high\", \"max\".",
        type: "invalid_request_error",
      },
    });
    const message = upstreamRefusal(400, body);
    expect(message).toContain("400");
    // The enumeration survives — this is the whole point.
    expect(message).toContain("must be one of");
    expect(message).toContain("max");
  });

  it("passes plain text through too, because a vendor is allowed to answer in prose", () => {
    expect(upstreamRefusal(422, "model is overloaded, try later")).toContain(
      "model is overloaded",
    );
  });

  it("keeps the status when the vendor said nothing usable", () => {
    expect(upstreamRefusal(500, "")).toBe("Upstream returned 500");
    expect(upstreamRefusal(500, "<html><body>502 Bad Gateway</body></html>")).toBe(
      "Upstream returned 500",
    );
  });

  it("does not hand back a page, an echoed request, or a megabyte", () => {
    // A body that echoes the request can carry the caller's own content; a page
    // of HTML is noise. Neither belongs in an error message.
    const html = upstreamRefusal(400, "<html><head><title>Error</title></head><body>x</body></html>");
    expect(html).not.toContain("<html>");
    const huge = JSON.stringify({ error: { message: "x".repeat(5000) } });
    expect(upstreamRefusal(400, huge).length).toBeLessThan(400);
    // Collapsed onto one line, so it cannot reflow a log or a panel.
    expect(upstreamRefusal(400, JSON.stringify({ error: { message: "a\n\n  b" } }))).toContain(
      "a b",
    );
  });

  it("and does not crash on a body that is not JSON at all", () => {
    expect(() => upstreamRefusal(400, "not json")).not.toThrow();
    expect(upstreamRefusal(400, "not json")).toContain("not json");
  });
});
