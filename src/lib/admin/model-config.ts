/**
 * src/lib/admin/model-config.ts
 *
 * The editable model rows, and the request they turn into.
 *
 * Plain data in, plain data out, no I/O — the same reasoning as
 * `lib/docs/custom.ts`. The rules worth testing are: which fields a given model
 * actually has, and what a save sends. Both used to be implicit in a component.
 *
 * **The point of this file.** The documentation page used to be able to change
 * four words about a model and nothing else; everything that decides how the
 * model behaves on the OpenAI-compatible surface — the context window, the
 * output cap, the prices, whether it answers at all, which upstream it reaches —
 * lived on the providers page, in a different table, under a different button.
 * Two places, one model.
 *
 * So the rows here carry the gateway configuration too, and the save writes
 * through to the provider record. There is still exactly one source of truth for
 * it: these fields are not a copy of the provider's values that can drift, they
 * *are* the provider's values, which is what keeps the documentation from
 * contradicting the gateway.
 */
import { ModelConfigSchema, type Provider } from "@/lib/db/types";
import type { MediaProvider } from "@/lib/media/spec";

export interface ModelNoteInput {
  displayName?: string;
  note?: string;
  tags?: string[];
  hidden?: boolean;
}

export interface ModelConfigRow {
  /** Which table the gateway half of this row lives in. */
  store: "provider" | "media";
  providerId: string;
  providerName: string;
  /** The id a client puts in the `model` field. Also the key for the docs note. */
  clientId: string;
  kind: "chat" | "media";
  /** Media only: which spec serves it. */
  capability: string | null;
  /** Media only: the path the spec posts to. */
  endpoint: string | null;
  /**
   * False for media models, whose gateway configuration is a spec rather than a
   * set of numbers. Offering a context window there would be a field that saves
   * and does nothing.
   */
  gatewayEditable: boolean;

  // Gateway configuration — the provider's own values.
  upstreamId: string;
  displayName: string;
  contextLength: number;
  maxOutputTokens: number;
  /**
   * The thinking levels this model takes, as the vendor writes them.
   *
   * Declared here rather than only scraped: most vendors publish no list at all,
   * so a field that can only be fetched is a field that stays empty exactly
   * where somebody needs it.
   */
  reasoningLevels: string[];
  inputCost: number;
  outputCost: number;
  /**
   * Per 1M tokens for cache reads and writes, optional because blank and
   * zero are different answers: blank means "charge the input price" and
   * zero means "this cache is free". Same distinction as on the providers
   * page, and it has to hold in both or the two pages disagree.
   */
  cachedInputCost?: number;
  cacheWriteCost?: number;
  /** Whether the gateway will route to this model at all. */
  enabled: boolean;
  /** Media only: whole credits charged per produced item. */
  pricePerItem: number | null;

  // Documentation prose.
  note: string;
  tags: string;
  hidden: boolean;
}

const DEFAULTS = { contextLength: 128000, maxOutputTokens: 8192, inputCost: 0, outputCost: 0 };

/**
 * One row per model the deployment serves.
 *
 * A provider's `modelConfigs` is keyed by client id, but a provider may also
 * have a plain `modelMapping` entry with no config behind it; those still appear
 * in the model list and are still editable, and a config is created for them on
 * first save.
 */
export function buildModelRows(
  providers: readonly Provider[],
  mediaProviders: readonly MediaProvider[],
  notes: Record<string, ModelNoteInput> = {},
): ModelConfigRow[] {
  const rows: ModelConfigRow[] = [];

  for (const provider of providers) {
    const seen = new Set<string>();
    for (const [clientId, cfg] of Object.entries(provider.modelConfigs ?? {})) {
      seen.add(clientId);
      rows.push(chatRow(provider, clientId, cfg, notes[clientId]));
    }
    for (const clientId of Object.keys(provider.modelMapping ?? {})) {
      if (seen.has(clientId)) continue;
      rows.push(chatRow(provider, clientId, null, notes[clientId]));
    }
  }

  for (const provider of mediaProviders) {
    for (const [clientId, cfg] of Object.entries(provider.models ?? {})) {
      const spec = (provider.specs ?? []).find((s) => s.capability === clientId);
      rows.push({
        store: "media",
        providerId: provider.id,
        providerName: provider.name,
        clientId,
        kind: "media",
        capability: spec?.capability ?? clientId,
        endpoint: spec?.transport?.path ?? null,
        // A media model is driven by its spec: the request and response shapes
        // come from there, and `spec-check` validates it. There is no context
        // window to set and no token price to set.
        gatewayEditable: false,
        upstreamId: cfg.upstreamId,
        displayName: notes[clientId]?.displayName ?? clientId,
        contextLength: DEFAULTS.contextLength,
        maxOutputTokens: DEFAULTS.maxOutputTokens,
        reasoningLevels: [],
        inputCost: 0,
        outputCost: 0,
        enabled: cfg.enabled,
        pricePerItem: cfg.pricePerItem,
        note: notes[clientId]?.note ?? "",
        tags: (notes[clientId]?.tags ?? []).join(", "),
        hidden: notes[clientId]?.hidden === true,
      });
    }
  }

  return rows;
}

function chatRow(
  provider: Provider,
  clientId: string,
  cfg: {
    upstreamId: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    /** What the vendor published, or what the operator declared. Absent on older rows. */
    reasoningLevels?: string[];
    inputCost?: number;
    outputCost?: number;
    cachedInputCost?: number;
    cacheWriteCost?: number;
    enabled?: boolean;
  } | null,
  note: ModelNoteInput | undefined,
): ModelConfigRow {
  return {
    store: "provider",
    providerId: provider.id,
    providerName: provider.name,
    clientId,
    kind: "chat",
    capability: null,
    endpoint: null,
    gatewayEditable: true,
    upstreamId: cfg?.upstreamId ?? provider.modelMapping?.[clientId] ?? clientId,
    displayName: cfg?.displayName ?? note?.displayName ?? clientId,
    contextLength: cfg?.contextLength ?? DEFAULTS.contextLength,
    maxOutputTokens: cfg?.maxOutputTokens ?? DEFAULTS.maxOutputTokens,
    // Empty rather than the common spellings: this is what the vendor's
    // model list said, and for most of them it said nothing.
    reasoningLevels: cfg?.reasoningLevels ?? [],
    inputCost: cfg?.inputCost ?? DEFAULTS.inputCost,
    outputCost: cfg?.outputCost ?? DEFAULTS.outputCost,
    // Spread, not `?? 0`: a cache nobody priced must read back as blank,
    // because 0 on this row means the cache is free.
    ...(cfg?.cachedInputCost !== undefined ? { cachedInputCost: cfg.cachedInputCost } : {}),
    ...(cfg?.cacheWriteCost !== undefined ? { cacheWriteCost: cfg.cacheWriteCost } : {}),
    enabled: cfg?.enabled ?? true,
    pricePerItem: null,
    note: note?.note ?? "",
    tags: (note?.tags ?? []).join(", "),
    hidden: note?.hidden === true,
  };
}

/** Why a row cannot be saved, or null. */
export function rowProblem(row: ModelConfigRow): string | null {
  if (!row.clientId.trim()) return "client id is empty";
  if (row.gatewayEditable && !row.upstreamId.trim()) return "upstream id is empty";
  for (const [label, value] of [
    ["context", row.contextLength],
    ["max output", row.maxOutputTokens],
  ] as const) {
    if (row.gatewayEditable && (!Number.isInteger(value) || value <= 0)) {
      return `${label} must be a positive whole number`;
    }
  }
  for (const [label, value] of [
    ["input cost", row.inputCost],
    ["output cost", row.outputCost],
  ] as const) {
    if (row.gatewayEditable && (!Number.isFinite(value) || value < 0)) {
      return `${label} cannot be negative`;
    }
  }
  // Skipped when absent: undefined is "charge the input price", which is valid.
  for (const [label, value] of [
    ["cache read cost", row.cachedInputCost],
    ["cache write cost", row.cacheWriteCost],
  ] as const) {
    if (row.gatewayEditable && value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return `${label} cannot be negative`;
    }
  }
  return null;
}

export interface ModelConfigPayload {
  models: Array<{
    providerId: string;
    clientId: string;
    upstreamId: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    /** What the vendor published, or what the operator declared. Absent on older rows. */
    reasoningLevels?: string[];
    inputCost?: number;
    outputCost?: number;
    /** `null` = clear the price, because this route merges and absent means keep. */
    cachedInputCost?: number | null;
    cacheWriteCost?: number | null;
    enabled?: boolean;
  }>;
  notes: Record<string, ModelNoteInput>;
}

/**
 * The request body for this form.
 *
 * Media rows contribute only their documentation note: their gateway fields are
 * a spec's, and sending them here would be sending values nothing reads.
 */
export function modelConfigPayload(rows: readonly ModelConfigRow[]): ModelConfigPayload {
  const notes: Record<string, ModelNoteInput> = {};
  for (const row of rows) {
    const out: ModelNoteInput = {};
    if (row.displayName.trim() && row.displayName.trim() !== row.clientId) {
      out.displayName = row.displayName.trim();
    }
    if (row.note.trim()) out.note = row.note.trim();
    const tags = row.tags.split(",").map((s) => s.trim()).filter(Boolean);
    if (tags.length) out.tags = tags;
    if (row.hidden) out.hidden = true;
    if (Object.keys(out).length > 0) notes[row.clientId] = out;
  }

  return {
    models: rows
      .filter((r) => r.gatewayEditable)
      .map((r) => ({
        providerId: r.providerId,
        clientId: r.clientId,
        upstreamId: r.upstreamId.trim(),
        ...(r.displayName.trim() ? { displayName: r.displayName.trim() } : {}),
        contextLength: r.contextLength,
        maxOutputTokens: r.maxOutputTokens,
        inputCost: r.inputCost,
        outputCost: r.outputCost,
        // Always sent, and blank becomes `null` rather than nothing: this route
        // merges, so an absent field reads as "keep the stored price" and a
        // cleared box would be unable to clear anything.
        cachedInputCost: r.cachedInputCost ?? null,
        cacheWriteCost: r.cacheWriteCost ?? null,
        enabled: r.enabled,
      })),
    notes,
  };
}

/**
 * Validate a payload against the same schema the providers page uses.
 *
 * Reused rather than restated: a field that would be rejected there must not be
 * accepted here, or this page becomes a second, looser door onto the same data.
 */
export function validateModelConfigPayload(
  payload: ModelConfigPayload,
): { ok: true } | { ok: false; message: string } {
  for (const m of payload.models) {
    const parsed = ModelConfigSchema.safeParse({
      upstreamId: m.upstreamId,
      clientId: m.clientId,
      displayName: m.displayName,
      contextLength: m.contextLength,
      maxOutputTokens: m.maxOutputTokens,
      inputCost: m.inputCost,
      outputCost: m.outputCost,
      cachedInputCost: m.cachedInputCost,
      cacheWriteCost: m.cacheWriteCost,
      enabled: m.enabled,
    });
    if (!parsed.success) {
      return { ok: false, message: `${m.clientId}: ${parsed.error.issues[0]?.message ?? "不合法"}` };
    }
  }
  return { ok: true };
}

/** The one-line summary a collapsed row shows. */
export function rowSummary(row: ModelConfigRow): string {
  const bits: string[] = [row.providerName];
  if (row.capability) bits.push(row.capability);
  if (row.gatewayEditable) {
    bits.push(`${formatTokens(row.contextLength)} / ${formatTokens(row.maxOutputTokens)}`);
  }
  if (row.pricePerItem !== null) bits.push(`${row.pricePerItem} 积分/件`);
  if (!row.enabled) bits.push("网关已停用");
  if (row.hidden) bits.push("文档已隐藏");
  if (row.note.trim()) bits.push("已写说明");
  return bits.join(" · ");
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}
