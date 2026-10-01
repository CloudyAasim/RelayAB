/**
 * src/lib/providers/known-models.ts
 *
 * Context windows for vendors whose numbers are published and stable.
 *
 * This exists because a wrong value here is worse than no value at all. A
 * provider that advertises a 200k model as 1M will accept prompts the upstream
 * then rejects, and the failure arrives as an opaque upstream error rather than
 * as "your request was too long". Anything not listed keeps the schema default
 * rather than being guessed.
 *
 * One table, used by both the completion script and the assistant's provider
 * tools, so the two cannot drift into disagreeing about the same model.
 *
 * Source: each vendor's published model table. Re-check before adding a model;
 * a retired id that lingers here is worse than a missing one.
 */

export interface KnownModel {
  /** Total context window, in tokens. */
  context: number;
  /** Maximum output tokens. */
  output: number;
}

/** MiniMax chat models. Verified against platform.minimaxi.com documentation. */
const MINIMAX: Record<string, KnownModel> = {
  "MiniMax-M3": { context: 1_000_000, output: 131_072 },
  "MiniMax-M2.7": { context: 204_800, output: 131_072 },
  "MiniMax-M2.7-highspeed": { context: 204_800, output: 131_072 },
  "MiniMax-M2.5": { context: 204_800, output: 131_072 },
  "MiniMax-M2.5-highspeed": { context: 204_800, output: 131_072 },
  "MiniMax-M2.1": { context: 204_800, output: 131_072 },
  "MiniMax-M2.1-highspeed": { context: 204_800, output: 131_072 },
  "MiniMax-M2": { context: 204_800, output: 131_072 },
  "M2-her": { context: 64_000, output: 8_192 },
};

/**
 * Longest-prefix match, so a vendor that suffixes its ids (`-highspeed`,
 * `-latest`, a dated build) still resolves to the base model's numbers.
 *
 * A suffix means a *newer* model than the base, and newer usually means at
 * least as capable — but not guaranteed larger, which is why this only fires on
 * a table entry the caller already trusts and the longest prefix wins.
 */
export function lookupKnownModel(modelId: string): KnownModel | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  if (MINIMAX[id]) return MINIMAX[id];

  let best: { key: string; value: KnownModel } | null = null;
  for (const [key, value] of Object.entries(MINIMAX)) {
    if (!id.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, value };
  }
  return best?.value;
}

/** The fallback used when a model is unknown: conservative, never optimistic. */
export const UNKNOWN_MODEL: KnownModel = { context: 128_000, output: 8_192 };

export function knownModelOrDefault(modelId: string): KnownModel {
  return lookupKnownModel(modelId) ?? UNKNOWN_MODEL;
}
