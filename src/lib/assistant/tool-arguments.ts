/**
 * src/lib/assistant/tool-arguments.ts
 *
 * Tool-call arguments, kept replayable.
 *
 * An assistant turn is a conversation with itself: every tool call the model
 * made is sent back on the next round, and the vendor parses those `arguments`
 * as JSON on arrival. A model that emits a truncated or otherwise malformed
 * argument string therefore does not just fail its own call — it poisons every
 * later round, and the vendor answers the whole turn with
 *
 *     400 Assistant tool call <id>.arguments must be valid JSON
 *
 * which this deployment surfaced as `上游调用失败（HTTP 502）` (2026-11-13). The
 * model never got a chance to correct itself: the request was rejected before
 * the model was read.
 *
 * So arguments are normalised to valid JSON the moment they come off the wire,
 * and again when a stored row is replayed — old transcripts may already contain
 * one. Nothing is silently swallowed: a call whose arguments did not parse is
 * marked, the tool is not executed with invented arguments, and the model is
 * told to re-emit the call. The failure then lands where the model can act on
 * it, instead of taking the whole turn down.
 */
export interface NormalizedToolArguments {
  /** JSON text that is safe to replay and to parse. */
  arguments: string;
  /** The vendor's own text was not a JSON object; `arguments` is `{}` instead. */
  invalid: boolean;
}

/**
 * Make a tool call's arguments replayable.
 *
 * - empty / whitespace → `{}` (a call with no parameters; some vendors send it
 *   as an empty string, and `JSON.parse("")` throws);
 * - a JSON **object** → kept byte for byte, because the protocol replays it;
 * - anything else (truncated text, `[]`, `5`, `null`) → `{}` and `invalid`.
 */
export function normalizeToolArguments(raw: unknown): NormalizedToolArguments {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { arguments: "{}", invalid: false };

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { arguments: text, invalid: false };
    }
    return { arguments: "{}", invalid: true };
  } catch {
    return { arguments: "{}", invalid: true };
  }
}
