/**
 * src/lib/proxy/validate.ts
 *
 * Request-shape checks that belong to the gateway, not to the upstream.
 *
 * Without them a malformed request costs an upstream round trip and comes back
 * as `502 upstream_error: "Upstream returned 400"` — a server-side error code
 * for what is a client-side mistake, and a message that says nothing about
 * which field was wrong. Two real cases found by probing the live endpoint:
 *
 *   {"model":"MiniMax-M2","messages":[]}   -> 502 "Upstream returned 400"
 *   {"model":"MiniMax-M2"}                  -> 502 "Upstream returned 400"
 *   {"model":"MiniMax-M2","max_tokens":-5}  -> 200, silently accepted
 *
 * The last one is the worse of the three: a negative token budget is nonsense,
 * and answering anyway means the caller believes they capped the response when
 * they did not.
 */

export interface ValidationError {
  status: number;
  code: string;
  message: string;
}

function invalid(message: string): ValidationError {
  return { status: 400, code: "invalid_request", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A conversation must carry at least one well-formed turn. */
function checkMessages(body: Record<string, unknown>, field = "messages"): ValidationError | null {
  const value = body[field];
  if (value === undefined) return invalid(`${field} is required`);
  if (!Array.isArray(value)) return invalid(`${field} must be an array`);
  if (value.length === 0) return invalid(`${field} must contain at least one message`);

  const bad = value.findIndex(
    (m) => !isPlainObject(m) || typeof m.role !== "string" || m.role.trim() === "",
  );
  if (bad !== -1) return invalid(`${field}[${bad}] must be an object with a non-empty "role"`);
  return null;
}

/**
 * Token caps on the OpenAI surfaces. Optional, but a supplied one must be a
 * positive integer: a negative or fractional budget is nonsense, and answering
 * anyway means the caller believes they capped a response they did not.
 *
 * The Anthropic surface is not checked here — `proxy/anthropic.ts` owns
 * `max_tokens` and answers with the more specific `missing_max_tokens`.
 */
function checkTokenCap(body: Record<string, unknown>, fields: string[]): ValidationError | null {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid(`${field} must be a number`);
    }
    if (!Number.isInteger(value) || value <= 0) {
      return invalid(`${field} must be a positive integer`);
    }
  }
  return null;
}

/** OpenAI Chat Completions: `messages` required, `max_tokens` optional. */
export function validateChatBody(body: unknown): ValidationError | null {
  if (!isPlainObject(body)) return invalid("request body must be a JSON object");
  return checkMessages(body) ?? checkTokenCap(body, ["max_tokens", "max_completion_tokens"]);
}

/**
 * Anthropic Messages.
 *
 * Only `messages` is checked here. `max_tokens` is deliberately left to
 * `proxy/anthropic.ts`, which already rejects it with the more specific
 * `missing_max_tokens` before any fetch. Two codes for one problem is worse
 * than one code in a layer further down.
 */
export function validateAnthropicBody(body: unknown): ValidationError | null {
  if (!isPlainObject(body)) return invalid("request body must be a JSON object");
  return checkMessages(body);
}

/**
 * OpenAI Responses: `input` is required but is a string *or* an array, so the
 * array check does not apply.
 */
export function validateResponsesBody(body: unknown): ValidationError | null {
  if (!isPlainObject(body)) return invalid("request body must be a JSON object");
  const input = body.input;
  if (input === undefined) return invalid("input is required");
  if (typeof input !== "string" && !Array.isArray(input)) {
    return invalid("input must be a string or an array");
  }
  if (Array.isArray(input) && input.length === 0) {
    return invalid("input must not be empty");
  }
  return checkTokenCap(body, ["max_output_tokens"]);
}
