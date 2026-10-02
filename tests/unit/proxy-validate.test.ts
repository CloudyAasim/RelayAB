/**
 * tests/unit/proxy-validate.test.ts
 *
 * Found by probing the live endpoint rather than by reading the proxy: a
 * malformed chat body was forwarded upstream and came back as
 * `502 upstream_error: "Upstream returned 400"` — a server error code for the
 * client's mistake, after paying for a round trip. A negative `max_tokens` was
 * worse: it returned 200, so the caller believed they had capped a response
 * they had not.
 */
import { describe, it, expect } from "vitest";
import {
  validateChatBody,
  validateAnthropicBody,
  validateResponsesBody,
} from "@/lib/proxy/validate";

const turn = { role: "user", content: "hi" };

describe("validateChatBody", () => {
  it("accepts a well-formed body", () => {
    expect(validateChatBody({ model: "m", messages: [turn], max_tokens: 100 })).toBeNull();
  });

  it("rejects a missing, non-array or empty messages field", () => {
    expect(validateChatBody({ model: "m" })?.message).toContain("messages is required");
    expect(validateChatBody({ model: "m", messages: "hi" })?.message).toContain("must be an array");
    expect(validateChatBody({ model: "m", messages: [] })?.message).toContain("at least one");
  });

  it("rejects a turn without a role, and says which one", () => {
    const err = validateChatBody({ model: "m", messages: [turn, { content: "x" }] });
    expect(err?.message).toContain("messages[1]");
    expect(err?.status).toBe(400);
  });

  it("rejects a non-positive or fractional token cap", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const err = validateChatBody({ model: "m", messages: [turn], max_tokens: bad });
      expect(err, `max_tokens=${bad} should be rejected`).not.toBeNull();
      expect(err?.status).toBe(400);
    }
  });

  it("allows max_completion_tokens and treats it the same way", () => {
    expect(validateChatBody({ model: "m", messages: [turn], max_completion_tokens: 64 })).toBeNull();
    expect(validateChatBody({ model: "m", messages: [turn], max_completion_tokens: -1 })).not.toBeNull();
  });

  it("is optional, so omitting the cap is fine", () => {
    expect(validateChatBody({ model: "m", messages: [turn] })).toBeNull();
  });

  it("rejects a non-object body", () => {
    expect(validateChatBody("hi")?.message).toContain("JSON object");
    expect(validateChatBody(null)?.message).toContain("JSON object");
  });
});

describe("validateAnthropicBody", () => {
  it("leaves max_tokens to the proxy layer", () => {
    // proxy/anthropic.ts already answers a missing/zero cap with the more
    // specific `missing_max_tokens`. Duplicating it here would give the same
    // problem two codes depending on which check ran first.
    expect(validateAnthropicBody({ model: "m", messages: [turn] })).toBeNull();
  });

  it("still checks messages", () => {
    expect(validateAnthropicBody({ model: "m", max_tokens: 64 })?.message).toContain(
      "messages is required",
    );
  });
});

describe("validateResponsesBody", () => {
  it("accepts a string or an array input", () => {
    expect(validateResponsesBody({ model: "m", input: "hi" })).toBeNull();
    expect(validateResponsesBody({ model: "m", input: [turn] })).toBeNull();
  });

  it("rejects a missing, empty or wrongly-typed input", () => {
    expect(validateResponsesBody({ model: "m" })?.message).toContain("input is required");
    expect(validateResponsesBody({ model: "m", input: [] })?.message).toContain("must not be empty");
    expect(validateResponsesBody({ model: "m", input: 42 })?.message).toContain("string or an array");
  });

  it("checks max_output_tokens", () => {
    expect(validateResponsesBody({ model: "m", input: "x", max_output_tokens: 0 })).not.toBeNull();
  });
});
