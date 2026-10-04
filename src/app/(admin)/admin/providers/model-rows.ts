/**
 * Row model behind `ProviderModelsEditor` — plain data, no React.
 *
 * Rows carry their own generated `id` because the obvious key (the client model
 * id) is the field the user types into: React keys are identity, so keying rows
 * by an editable value remounts the row on every keystroke and the input loses
 * focus mid-word. The `id` never reaches the payload — that stays keyed by the
 * client-facing model id.
 */

import type { ModelEntryFacts } from "@/lib/providers/upstream";

export interface ProviderModelRow {
  /** React key only — never a user-editable value. */
  id: string;
  /** Client-facing model id the caller asks for. */
  clientId: string;
  /** The vendor's own model name. */
  upstreamId: string;
  contextLength: number;
  maxOutputTokens: number;
  inputCost: number;
  outputCost: number;
  /**
   * Optional because blank and zero are different answers here.
   *
   * `undefined` is "charge the input price", the safe default for a model
   * row written before caching existed. `0` is "this cache is free", a real
   * answer that has to survive the round trip — and the numeric inputs below
   * cannot express it, because a 0 there is dropped and the schema default
   * reapplies. Hence a number-or-undefined rather than a number.
   */
  cachedInputCost?: number;
  cacheWriteCost?: number;
}

export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

let newRowSeq = 0;

/** A blank row. Ids from here are only ever minted on the client, after hydration. */
export function newModelRow(partial: Partial<Omit<ProviderModelRow, "id">> = {}): ProviderModelRow {
  newRowSeq += 1;
  return {
    id: `new-${newRowSeq}`,
    clientId: "",
    upstreamId: "",
    contextLength: DEFAULT_CONTEXT_LENGTH,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    inputCost: 0,
    outputCost: 0,
    ...partial,
  };
}

interface StoredModelConfig {
  upstreamId?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  inputCost?: number;
  outputCost?: number;
  cachedInputCost?: number;
  cacheWriteCost?: number;
}

/**
 * Turn what the API returned into editable rows.
 *
 * Ids are positional so the server-rendered pass and the hydrated client pass
 * agree (a counter or `randomUUID()` here would trip hydration).
 */
export function rowsFromProvider(
  modelMapping: Record<string, string> = {},
  modelConfigs: Record<string, unknown> = {},
): ProviderModelRow[] {
  return Object.entries(modelMapping).map(([clientId, upstreamId], index) => {
    const config = (modelConfigs?.[clientId] ?? {}) as StoredModelConfig;
    return {
      id: `saved-${index}`,
      clientId,
      upstreamId: config.upstreamId ?? upstreamId,
      contextLength: config.contextLength ?? DEFAULT_CONTEXT_LENGTH,
      maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      inputCost: config.inputCost ?? 0,
      outputCost: config.outputCost ?? 0,
      // Not `?? 0`: a row whose cache was never priced has to read back as
      // blank, and a 0 here would mean the opposite of what it means on the
      // input row.
      ...(config.cachedInputCost !== undefined ? { cachedInputCost: config.cachedInputCost } : {}),
      ...(config.cacheWriteCost !== undefined ? { cacheWriteCost: config.cacheWriteCost } : {}),
    };
  });
}

/**
 * Build the API payload.
 *
 * Rows still being typed into (missing either id) are skipped. A numeric field
 * left blank or zero is omitted so `ModelConfigSchema`'s defaults apply instead
 * of failing validation on a `0` context length.
 */
export function rowsToPayload(rows: ProviderModelRow[]): {
  modelMapping: Record<string, string>;
  modelConfigs: Record<string, Record<string, unknown>>;
} {
  const modelMapping: Record<string, string> = {};
  const modelConfigs: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    const clientId = row.clientId.trim();
    const upstreamId = row.upstreamId.trim();
    if (!clientId || !upstreamId) continue;

    modelMapping[clientId] = upstreamId;
    const config: Record<string, unknown> = { clientId, upstreamId, enabled: true };
    if (row.contextLength > 0) config.contextLength = row.contextLength;
    if (row.maxOutputTokens > 0) config.maxOutputTokens = row.maxOutputTokens;
    if (row.inputCost > 0) config.inputCost = row.inputCost;
    if (row.outputCost > 0) config.outputCost = row.outputCost;
    // `!== undefined`, not `> 0`: zero is "this cache is free" and has to be
    // written, while blank has to stay absent so the input price applies.
    if (row.cachedInputCost !== undefined) config.cachedInputCost = row.cachedInputCost;
    if (row.cacheWriteCost !== undefined) config.cacheWriteCost = row.cacheWriteCost;
    modelConfigs[clientId] = config;
  }

  return { modelMapping, modelConfigs };
}

/** Client model ids claimed by more than one row — only the last one is saved. */
export function duplicateClientIds(rows: ProviderModelRow[]): string[] {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const id = row.clientId.trim();
    if (!id) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Append the upstream models that are not represented yet ("fetch models").
 *
 * The whole entry, not just its id, because that is the point of fetching: an
 * upstream that publishes a context window or an output cap has answered the
 * question, and the operator should not be asked it again. A field the vendor
 * did not publish is left at the row's own default rather than guessed —
 * `undefined` here would become a stored number nobody chose.
 */
export function mergeFetchedModels(
  rows: ProviderModelRow[],
  fetched: readonly (string | ModelEntryFacts)[],
  defaults: Partial<Omit<ProviderModelRow, "id">> = {},
): ProviderModelRow[] {
  const entries = fetched.map((f) => (typeof f === "string" ? { id: f } : f));
  const known = new Set(rows.flatMap((row) => [row.clientId.trim(), row.upstreamId.trim()]));
  const additions = entries
    .map((e) => ({ ...e, id: e.id.trim() }))
    .filter((e) => e.id.length > 0 && !known.has(e.id))
    .map((e) =>
      newModelRow({
        ...defaults,
        clientId: e.id,
        upstreamId: e.id,
        ...(e.contextLength !== undefined ? { contextLength: e.contextLength } : {}),
        ...(e.maxOutputTokens !== undefined ? { maxOutputTokens: e.maxOutputTokens } : {}),
      }),
    );
  return additions.length > 0 ? [...rows, ...additions] : rows;
}
