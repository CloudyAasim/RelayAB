/**
 * src/lib/quota/rates.ts
 *
 * Where a request's 积分 price comes from.
 *
 * The rate belongs to **one model row of one provider** — the client-facing
 * model id as it is mapped inside that provider. Prices differ between vendors
 * serving the same upstream model, and they differ between the models of a
 * single vendor, so the rate is stored on the model itself and nothing is
 * inferred from the model name.
 *
 * Rates are 积分 per 1,000,000 tokens, so the numbers stay small integers the
 * operator can type into the admin panel:
 *
 *   units (0.001-积分) = round(
 *     (promptTokens × inputPerMillion + completionTokens × outputPerMillion) / 1000
 *   )
 *
 * A rate of 0 means free. There is no second level and no fallback: the value on
 * the model row is the whole answer, so "why did this cost that?" always has a
 * single, visible answer in the admin panel.
 *
 * There is deliberately no built-in price table and no implicit charge for
 * "unknown" models either: an unconfigured model costs nothing.
 */
import type { ModelConfig } from "../db/types";

export interface ModelRate {
  /** 积分 per 1,000,000 prompt (input) tokens. */
  inputPerMillion: number;
  /** 积分 per 1,000,000 completion (output) tokens. */
  outputPerMillion: number;
}

/** Charging nothing — the default for a model with no rate configured. */
export const FREE_RATE: ModelRate = { inputPerMillion: 0, outputPerMillion: 0 };

/**
 * Rate of one model row. Missing config or a missing/garbled value means free.
 */
export function resolveModelRate(
  modelConfig?: Pick<ModelConfig, "inputCost" | "outputCost"> | null,
): ModelRate {
  if (!modelConfig) return FREE_RATE;
  return {
    inputPerMillion: nonNegative(modelConfig.inputCost),
    outputPerMillion: nonNegative(modelConfig.outputCost),
  };
}

/**
 * How many 积分 a request consumed, as an integer count of 0.001-积分 units
 * (see `credits.ts`). Non-finite or negative token counts count as zero.
 */
export function computeCredits(args: {
  rate: ModelRate;
  promptTokens: number;
  completionTokens: number;
}): number {
  const promptTokens = toTokenCount(args.promptTokens);
  const completionTokens = toTokenCount(args.completionTokens);
  const input = nonNegative(args.rate.inputPerMillion);
  const output = nonNegative(args.rate.outputPerMillion);

  const total = (promptTokens * input + completionTokens * output) / 1000;
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, Math.round(total));
}

/** Coerce a token count into a non-negative finite integer. */
function toTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Missing / malformed rates are treated as "not charged". */
function nonNegative(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}
