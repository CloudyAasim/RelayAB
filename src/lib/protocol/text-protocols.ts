/**
 * src/lib/protocol/text-protocols.ts
 *
 * The four shapes a text provider can speak, as ready-made specs.
 *
 * This is the answer to "the configuration is fairly uniform". It is not
 * uniform enough to have no configuration at all — vendors rename things,
 * nest things under `extra_body`, and disagree about where the token cap goes —
 * but it *is* uniform enough that the common case should be one dropdown.
 *
 * A preset is an ordinary spec with `parameters` and `request` filled in. An
 * operator who picks `openai-chat` and changes nothing gets a transparent
 * relay; one whose vendor deviates edits the mapping, and the spec-check
 * contract still applies.
 */
import type { TextProtocol, TextSpec } from "./text-spec";

const OPENAI_CHAT: TextSpec = {
  specVersion: 1,
  protocol: "openai-chat",
  // Already the shape we speak, so nothing needs rebuilding — the params are
  // declared so the background page can show them, not so they are enforced.
  parameters: {
    reasoning_effort: { mode: "passthrough" },
    temperature: { mode: "clamp", min: 0, max: 2 },
    max_tokens: { mode: "clamp", max: 131072 },
  },
  limits: { timeoutMs: 600000 },
};

const OPENAI_RESPONSES: TextSpec = {
  specVersion: 1,
  protocol: "openai-responses",
  parameters: {
    reasoning: { mode: "rename", to: "reasoning" },
    temperature: { mode: "clamp", min: 0, max: 2 },
    max_output_tokens: { mode: "rename", to: "max_output_tokens" },
  },
  limits: { timeoutMs: 600000 },
};

const ANTHROPIC_MESSAGES: TextSpec = {
  specVersion: 1,
  protocol: "anthropic-messages",
  parameters: {
    // The client says `max_tokens`; Anthropic requires it, Chat Completions
    // treats it as optional. Renaming rather than dropping is what stops a
    // default being invented for a field the protocol requires.
    max_tokens: { mode: "rename", to: "max_tokens" },
    max_completion_tokens: { mode: "rename", to: "max_tokens" },
    temperature: { mode: "clamp", min: 0, max: 1 },
    stop: { mode: "rename", to: "stop_sequences" },
    // Anthropic rejects `temperature` alongside extended thinking, so an
    // operator who enables thinking has to drop it deliberately rather than
    // discovering the 400 in production.
    thinking: { mode: "passthrough" },
  },
  errors: [{ httpStatus: 529, code: "overloaded" }],
  limits: { timeoutMs: 600000 },
};

const GEMINI_GENERATE: TextSpec = {
  specVersion: 1,
  protocol: "gemini-generate",
  parameters: {
    max_tokens: { mode: "rename", to: "generationConfig.maxOutputTokens" },
    temperature: { mode: "rename", to: "generationConfig.temperature" },
    top_p: { mode: "rename", to: "generationConfig.topP" },
    stop: { mode: "rename", to: "generationConfig.stopSequences" },
    reasoning_effort: { mode: "drop" },
  },
  limits: { timeoutMs: 600000 },
};

export const TEXT_PROTOCOL_PRESETS: Record<TextProtocol, TextSpec> = {
  "openai-chat": OPENAI_CHAT,
  "openai-responses": OPENAI_RESPONSES,
  "anthropic-messages": ANTHROPIC_MESSAGES,
  "gemini-generate": GEMINI_GENERATE,
};

/** One-line summary for the preset picker. */
export const TEXT_PROTOCOL_LABELS: Record<TextProtocol, { zh: string; en: string; hint: string }> = {
  "openai-chat": {
    zh: "OpenAI Chat Completions",
    en: "OpenAI Chat Completions",
    hint: "大多数厂商（含 MiniMax、OpenAI 兼容中转）都是这个。选它通常什么都不用改。",
  },
  "openai-responses": {
    zh: "OpenAI Responses",
    en: "OpenAI Responses",
    hint: "上游原生支持 /v1/responses。Codex CLI 直连这种上游时选它。",
  },
  "anthropic-messages": {
    zh: "Anthropic Messages",
    en: "Anthropic Messages",
    hint: "Anthropic 官方或任何 /v1/messages 兼容上游。token 上限叫 max_tokens，停词叫 stop_sequences。",
  },
  "gemini-generate": {
    zh: "Google Gemini",
    en: "Google Gemini",
    hint: "Gemini 的 generateContent，参数都塞在 generationConfig 下面。",
  },
};

/** A fresh, editable copy — the presets are never mutated in place. */
export function protocolPreset(protocol: TextProtocol): TextSpec {
  return structuredClone(TEXT_PROTOCOL_PRESETS[protocol]);
}
