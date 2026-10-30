/**
 * src/lib/protocol/stream-frames.ts
 *
 * The frames a token stream is made of, and the translation between dialects.
 *
 * ## The problem
 *
 * Four dialects carry a token stream through this gateway: the Responses API,
 * Chat Completions, Anthropic Messages and Google's Gemini. They agree on what
 * a stream *is* — a series of frames carrying text and, at the end, the usage
 * — and disagree on everything else: the field names, the event names, where
 * the usage turns up, and whether the last frame says "I am done".
 *
 * ## The pivot
 *
 * The Responses API is the pivot, for the same reason it is the pivot for
 * requests: it is the one shape this gateway already speaks end to end. So an
 * upstream that speaks another dialect is read by {@link readStreamFacts} — one
 * reader for all four — and written back out in the pivot's frames; the
 * surface the client called reads those.
 *
 * ## What is *not* here
 *
 * Billing. The stream being read settles its own usage when it ends (see
 * `ssePassthrough` in `lib/proxy/stream-tap.ts`); this module only reads and
 * writes frames.
 */

import { geminiOutputTokens } from "./gemini";

/**
 * What one frame carries, whichever dialect it came from.
 *
 * The usage arrives in pieces in some dialects — Anthropic reports the input
 * tokens on `message_start` and the output tokens on `message_delta` — so the
 * fields are "what this frame said", not "the total so far". The caller merges
 * them.
 */
export interface StreamFacts {
  /** The text this frame delivers, if any. */
  text?: string;
  /**
   * The thinking this frame delivers, if any.
   *
   * A frame can carry the model's reasoning separately from its answer, and
   * for the vendors that require it the reasoning has to reach the client —
   * otherwise the client has nothing to echo back on the next turn.
   */
  reasoning?: string;
  /** The input tokens this frame reports, if any. */
  inputTokens?: number;
  /** The output tokens this frame reports, if any. */
  outputTokens?: number;
  /** True on the frame that ends the stream. */
  end?: boolean;
  /** The response id, when the dialect names one. */
  id?: string;
  /** The model name, when the dialect names one. */
  model?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one frame of any dialect into the facts it carries.
 *
 * One reader for four dialects, because the differences are all in the field
 * names and none of them are in the meaning: a frame carries text, or usage,
 * or the end of the stream, and a reader that knew four vocabularies would
 * have to be right about all of them.
 */
export function readStreamFacts(payload: unknown): StreamFacts {
  const root = asRecord(payload);
  if (!root) return {};

  const facts: StreamFacts = {};
  const type = typeof root.type === "string" ? root.type : "";

  // --- The Responses API ---
  if (type === "response.output_text.delta") {
    if (typeof root.delta === "string") facts.text = root.delta;
    return facts;
  }
  if (type === "response.reasoning_text.delta") {
    if (typeof root.delta === "string") facts.reasoning = root.delta;
    return facts;
  }
  if (type === "response.completed") {
    const response = asRecord(root.response);
    const usage = asRecord(response?.usage);
    if (usage) {
      facts.inputTokens = num(usage.input_tokens) ?? num(usage.prompt_tokens);
      facts.outputTokens = num(usage.output_tokens) ?? num(usage.completion_tokens);
    }
    if (typeof response?.id === "string") facts.id = response.id;
    if (typeof response?.model === "string") facts.model = response.model;
    facts.end = true;
    return facts;
  }

  // --- Chat Completions ---
  if (root.object === "chat.completion.chunk" || Array.isArray(root.choices)) {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = asRecord(choices[0]);
    const delta = asRecord(first?.delta);
    if (typeof delta?.content === "string" && delta.content) facts.text = delta.content;
    // The thinking, in whichever of the two spellings the vendor used.
    const thinking = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof thinking === "string" && thinking) facts.reasoning = thinking;
    if (first?.finish_reason) facts.end = true;
    const usage = asRecord(root.usage);
    if (usage) {
      facts.inputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens);
      facts.outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens);
    }
    if (typeof root.id === "string") facts.id = root.id;
    if (typeof root.model === "string") facts.model = root.model;
    return facts;
  }
  // The usage-only frame a Chat upstream sends when it was asked for one.
  if (root.usage && !root.choices) {
    const usage = asRecord(root.usage);
    facts.inputTokens = num(usage?.prompt_tokens) ?? num(usage?.input_tokens);
    facts.outputTokens = num(usage?.completion_tokens) ?? num(usage?.output_tokens);
    return facts;
  }

  // --- Anthropic Messages ---
  if (type === "content_block_delta") {
    const delta = asRecord(root.delta);
    if (typeof delta?.text === "string" && delta.text) facts.text = delta.text;
    return facts;
  }
  if (type === "message_start") {
    const message = asRecord(root.message);
    const usage = asRecord(message?.usage);
    if (usage) facts.inputTokens = num(usage.input_tokens);
    if (typeof message?.id === "string") facts.id = message.id;
    if (typeof message?.model === "string") facts.model = message.model;
    return facts;
  }
  if (type === "message_delta") {
    const usage = asRecord(root.usage);
    if (usage) facts.outputTokens = num(usage.output_tokens);
    return facts;
  }
  if (type === "message_stop") {
    facts.end = true;
    return facts;
  }

  // --- Google Gemini ---
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  if (candidates.length > 0) {
    const candidate = asRecord(candidates[0]);
    const content = asRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts
      .map((part) => asRecord(part))
      .filter((part): part is Record<string, unknown> => part !== null)
      // A thought is the model's own reasoning, not part of the answer.
      .filter((part) => part.thought !== true)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    if (text) facts.text = text;
    if (candidate?.finishReason) facts.end = true;
    const meta = asRecord(root.usageMetadata);
    if (meta) {
      facts.inputTokens = num(meta.promptTokenCount);
      facts.outputTokens = geminiOutputTokens(meta);
    }
    if (typeof root.responseId === "string") facts.id = root.responseId;
    if (typeof root.modelVersion === "string") facts.model = root.modelVersion;
    return facts;
  }
  const meta = asRecord(root.usageMetadata);
  if (meta) {
    facts.inputTokens = num(meta.promptTokenCount);
    facts.outputTokens = geminiOutputTokens(meta);
  }

  return facts;
}

/**
 * Read an upstream's frames and write the pivot's.
 *
 * The upstream may speak any dialect: the frames are read with
 * {@link readStreamFacts} and written out in the Responses shape, which is what
 * the surface the client called knows how to read.
 *
 * The closing frame is written at the end of the stream rather than when the
 * upstream says "I am done", because the dialects disagree about where the
 * usage sits: a Chat upstream sends its usage frame *after* the chunk that
 * carries the finish reason, so a frame written at that point would have no
 * usage in it.
 */
export function pivotFrameMapper(model?: string): {
  map: (line: string) => string | string[] | null;
  onEnd: () => string | string[] | null;
} {
  const state = {
    inputTokens: 0,
    outputTokens: 0,
    id: undefined as string | undefined,
    model: undefined as string | undefined,
  };

  const completed = (): string[] => {
    const id = state.id ?? `resp_${Math.random().toString(36).slice(2, 10)}`;
    const payload = {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        model: state.model ?? model ?? "",
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          total_tokens: state.inputTokens + state.outputTokens,
        },
      },
    };
    return [`event: response.completed`, `data: ${JSON.stringify(payload)}`];
  };

  return {
    map(line: string): string[] | null {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return null;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return null;

      let facts: StreamFacts;
      try {
        facts = readStreamFacts(JSON.parse(payload));
      } catch {
        // A partial or non-JSON keep-alive frame: nothing to translate.
        return null;
      }

      if (facts.inputTokens !== undefined) state.inputTokens = facts.inputTokens;
      if (facts.outputTokens !== undefined) state.outputTokens = facts.outputTokens;
      if (facts.id) state.id = facts.id;
      if (facts.model) state.model = facts.model;

      if (!facts.text && !facts.reasoning) return null;

      const out: string[] = [];
      if (facts.reasoning) {
        /**
         * The thinking, in Responses' own vocabulary.
         *
         * A client that has to echo the reasoning back cannot do it if the
         * reasoning never reached it — so the stream carries it, in the event
         * type the Responses API uses for it.
         */
        const reasoningDelta = {
          type: "response.reasoning_text.delta",
          delta: facts.reasoning,
        };
        out.push(
          `event: response.reasoning_text.delta`,
          `data: ${JSON.stringify(reasoningDelta)}`,
        );
      }
      if (facts.text) {
        const delta = {
          type: "response.output_text.delta",
          delta: facts.text,
        };
        out.push(`event: response.output_text.delta`, `data: ${JSON.stringify(delta)}`);
      }
      return out;
    },

    onEnd(): string[] {
      return completed();
    },
  };
}

/**
 * Read the pivot's frames and write Chat Completions chunks.
 *
 * The other direction: the client asked for Chat and the pivot speaks
 * Responses, so the frames have to change shape on the way out. The Chat
 * dialect's closing frames are three — the chunk that carries the finish
 * reason, the usage frame, and `[DONE]` — and all three are written here.
 */
export function chatFrameMapper(model?: string): {
  map: (line: string) => string | string[] | null;
  onEnd: () => string | string[] | null;
} {
  const created = Math.floor(Date.now() / 1000);
  /**
   * One identity for the whole stream.
   *
   * The pivot's answer names the *upstream's* response, and it only says so in
   * the closing frame — so a chunk written earlier could not know it. A stream
   * that changes its id or its model halfway is worse than one that names the
   * client's model throughout, so the identity is fixed here and never
   * overwritten.
   */
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const state = {
    inputTokens: 0,
    outputTokens: 0,
  };
  let finished = false;

  const chunk = (delta: Record<string, unknown>, finish: string | null): string => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model: model ?? "",
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(payload)}`;
  };

  const usageFrame = (): string => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model: model ?? "",
      choices: [],
      usage: {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
      },
    };
    return `data: ${JSON.stringify(payload)}`;
  };

  const closing = (): string[] => {
    if (finished) return [];
    finished = true;
    return [chunk({}, "stop"), usageFrame(), "data: [DONE]"];
  };

  return {
    map(line: string): string | string[] | null {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return null;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return null;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return null;
      }

      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
        return chunk({ content: parsed.delta }, null);
      }
      // The thinking, carried across so a Chat client can echo it back.
      if (type === "response.reasoning_text.delta" && typeof parsed.delta === "string") {
        return chunk({ reasoning_content: parsed.delta }, null);
      }
      if (type === "response.completed") {
        const response = asRecord(parsed.response);
        const usage = asRecord(response?.usage);
        if (usage) {
          state.inputTokens = num(usage.input_tokens) ?? 0;
          state.outputTokens = num(usage.output_tokens) ?? 0;
        }
        return closing();
      }
      return null;
    },

    onEnd(): string[] {
      return closing();
    },
  };
}
