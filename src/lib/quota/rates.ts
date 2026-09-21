/**
 * src/lib/quota/rates.ts
 *
 * How many 积分 each model consumes per token.
 *
 * The table is expressed in **积分 per 1,000,000 tokens** so the values are
 * plain integers (no fractional literals). A request's consumption is:
 *
 *   units = (promptTokens * inputPerMillion + completionTokens * outputPerMillion) / 1000
 *           rounded to the nearest integer
 *
 * where `units` are the stored 0.001-积分 units described in `credits.ts`.
 *
 * Rates can be overridden at runtime via `applyRateOverride()`.
 */
import { creditsToUnits } from "./credits";

export interface ModelRate {
  /** 积分 per 1,000,000 prompt (input) tokens. */
  inputPerMillion: number;
  /** 积分 per 1,000,000 completion (output) tokens. */
  outputPerMillion: number;
}

// ---------------------------------------------------------------------------
// Built-in rates
// ---------------------------------------------------------------------------

/**
 * Keys are the model identifiers that appear upstream (i.e. after applying
 * `Provider.modelMapping`). Unknown models fall back to `DEFAULT_RATE`.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  // OpenAI
  "gpt-4o": { inputPerMillion: 250, outputPerMillion: 1000 },
  "gpt-4o-2024-08-06": { inputPerMillion: 250, outputPerMillion: 1000 },
  "gpt-4o-mini": { inputPerMillion: 15, outputPerMillion: 60 },
  "gpt-4o-mini-2024-07-18": { inputPerMillion: 15, outputPerMillion: 60 },
  "gpt-4-turbo": { inputPerMillion: 1000, outputPerMillion: 3000 },
  "gpt-4": { inputPerMillion: 3000, outputPerMillion: 6000 },
  "gpt-3.5-turbo": { inputPerMillion: 50, outputPerMillion: 150 },
  "o1": { inputPerMillion: 1500, outputPerMillion: 6000 },
  "o1-mini": { inputPerMillion: 300, outputPerMillion: 1200 },
  "o3-mini": { inputPerMillion: 110, outputPerMillion: 440 },

  // Anthropic
  "claude-3-5-sonnet-20241022": { inputPerMillion: 300, outputPerMillion: 1500 },
  "claude-3-5-sonnet-20240620": { inputPerMillion: 300, outputPerMillion: 1500 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 80, outputPerMillion: 400 },
  "claude-3-opus-20240229": { inputPerMillion: 1500, outputPerMillion: 7500 },
  "claude-3-sonnet-20240229": { inputPerMillion: 300, outputPerMillion: 1500 },
  "claude-3-haiku-20240307": { inputPerMillion: 25, outputPerMillion: 125 },
};

/** Fallback rate for models that aren't in the table (deliberately generous). */
export const DEFAULT_RATE: ModelRate = {
  inputPerMillion: 500,
  outputPerMillion: 1500,
};

/** Look up the rate for a model id (post-mapping). */
export function getModelRate(modelId: string): ModelRate {
  return MODEL_RATES[modelId] ?? DEFAULT_RATE;
}

// ---------------------------------------------------------------------------
// Consumption computation
// ---------------------------------------------------------------------------

/**
 * Compute how many 积分 a request consumed, returned as an integer count of
 * 0.001-积分 units (see `credits.ts`).
 *
 * Negative or non-finite token counts are treated as zero.
 */
export function computeCredits(args: {
  model: string;
  promptTokens: number;
  completionTokens: number;
}): number {
  const rate = getModelRate(args.model);
  const promptTokens = toTokenCount(args.promptTokens);
  const completionTokens = toTokenCount(args.completionTokens);

  const total =
    (promptTokens * rate.inputPerMillion + completionTokens * rate.outputPerMillion) / 1000;

  if (!Number.isFinite(total)) return 0;
  return Math.max(0, Math.round(total));
}

/** Coerce a token count into a non-negative finite integer. */
function toTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

/**
 * Apply a JSON override table, e.g.
 *   {"gpt-4o":{"inputPerMillion":260,"outputPerMillion":1100}}
 *
 * Malformed input is ignored so the built-in table always remains usable.
 */
export function applyRateOverride(json: string | undefined): void {
  if (!json) return;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return;
    for (const [model, value] of Object.entries(parsed)) {
      const rate = parseOverrideEntry(value);
      if (rate) MODEL_RATES[model] = rate;
    }
  } catch {
    // Ignore malformed input.
  }
}

/**
 * Accept either the current shape (`inputPerMillion` / `outputPerMillion`) or
 * a credit-per-1,000-tokens shape (`inputPer1kCredits` / `outputPer1kCredits`),
 * normalising both to the per-million form.
 */
function parseOverrideEntry(value: unknown): ModelRate | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const inputPerMillion = raw.inputPerMillion;
  const outputPerMillion = raw.outputPerMillion;
  if (typeof inputPerMillion === "number" && typeof outputPerMillion === "number") {
    return { inputPerMillion, outputPerMillion };
  }

  const inputPer1k = raw.inputPer1kCredits;
  const outputPer1k = raw.outputPer1kCredits;
  if (typeof inputPer1k === "number" && typeof outputPer1k === "number") {
    return {
      inputPerMillion: creditsToUnits(inputPer1k),
      outputPerMillion: creditsToUnits(outputPer1k),
    };
  }

  return null;
}
