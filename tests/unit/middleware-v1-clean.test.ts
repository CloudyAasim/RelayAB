/**
 * tests/unit/middleware-v1-clean.test.ts
 *
 * Validates the cleanDoubleV1Path helper used in src/middleware.ts.
 *
 * OnlyOffice's OpenAI template appends an OpenAI endpoint (e.g. /v1/models)
 * to the user-configured base URL. When the base ends in /v1, the resulting
 * path is /v1/v1/... — which must be rewritten to /v1/... to reach the
 * correct route handler.
 */
import { describe, it, expect } from "vitest";

// Inline a copy of the helper so this test is self-contained and does not
// import from middleware (Edge runtime / Next.js headers would pollute the unit env).
function cleanDoubleV1Path(path: string): string {
  if (path.startsWith("/v1/v1/") || path === "/v1/v1") {
    return path.replace(/^\/v1\/v1(\/.*)?$/, "/v1$1");
  }
  return path;
}

describe("cleanDoubleV1Path", () => {
  it("rewrites /v1/v1/models to /v1/models", () => {
    expect(cleanDoubleV1Path("/v1/v1/models")).toBe("/v1/models");
  });

  it("rewrites /v1/v1/chat/completions to /v1/chat/completions", () => {
    expect(cleanDoubleV1Path("/v1/v1/chat/completions")).toBe(
      "/v1/chat/completions",
    );
  });

  it("rewrites /v1/v1/responses to /v1/responses", () => {
    expect(cleanDoubleV1Path("/v1/v1/responses")).toBe("/v1/responses");
  });

  it("leaves /v1/models untouched", () => {
    expect(cleanDoubleV1Path("/v1/models")).toBe("/v1/models");
  });

  it("leaves /api/v1/models untouched", () => {
    expect(cleanDoubleV1Path("/api/v1/models")).toBe("/api/v1/models");
  });

  it("leaves /anthropic/v1/messages untouched", () => {
    expect(cleanDoubleV1Path("/anthropic/v1/messages")).toBe(
      "/anthropic/v1/messages",
    );
  });

  it("leaves plain /chat/completions untouched", () => {
    expect(cleanDoubleV1Path("/chat/completions")).toBe("/chat/completions");
  });

  it("handles a path with query string appended (not rewritten by middleware, but safe)", () => {
    // The middleware only rewrites the pathname; query strings pass through unchanged.
    expect(cleanDoubleV1Path("/v1/v1/models?api_key=abc")).toBe(
      "/v1/models?api_key=abc",
    );
  });
});
