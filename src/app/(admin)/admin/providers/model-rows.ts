/**
 * Row model behind `ProviderModelsEditor` — plain data, no React.
 *
 * Rows carry their own generated `id` because the obvious key (the client model
 * id) is the field the user types into: React keys are identity, so keying rows
 * by an editable value remounts the row on every keystroke and the input loses
 * focus mid-word. The `id` never reaches the payload — that stays keyed by the
 * client-facing model id.
 */

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

/** Append the upstream ids that are not represented yet (used by "fetch models"). */
export function mergeFetchedModels(
  rows: ProviderModelRow[],
  upstreamIds: string[],
  defaults: Partial<Omit<ProviderModelRow, "id">> = {},
): ProviderModelRow[] {
  const known = new Set(rows.flatMap((row) => [row.clientId.trim(), row.upstreamId.trim()]));
  const additions = upstreamIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && !known.has(id))
    .map((id) => newModelRow({ ...defaults, clientId: id, upstreamId: id }));
  return additions.length > 0 ? [...rows, ...additions] : rows;
}
