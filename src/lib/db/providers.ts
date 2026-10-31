/**
 * src/lib/db/providers.ts
 *
 * Repository for upstream `Provider` entities.
 *
 * Backed by the single SQLite file managed in `sqlite.ts`. The Redis version
 * enumerated providers with a cursor SCAN over `relay:provider:*` and then
 * issued one pipelined HGETALL per matched key; the same "read them all" need
 * here is a single SELECT, so the whole provider set costs one statement
 * instead of a round trip per provider.
 *
 *   TABLE providers → one row per upstream vendor.
 *
 * Structured columns (`model_mapping`, `model_configs`, `headers`) hold JSON
 * text and are re-parsed by the shared `rowToProvider`, which also runs the
 * row through `ProviderSchema`. That replaces the hand-written
 * `hashToProvider` deserialiser the Redis version needed — every hash field
 * came back as a string, so booleans had to be sniffed as "1"/"true"/"on" and
 * empty strings had to be re-mapped to null. Typed columns make that class of
 * bug unrepresentable.
 */
import {
  ProviderSchema,
  defaultFaceFlags,
  providerFaces,
  type Provider,
  type ProviderKind,
  type ModelConfig,
  type ModelConfigPatch,
} from "./types";
import { revalidateTag, unstable_cache } from "next/cache";
import { getAll, getOne, rowToProvider, run, toDbBool, withTransaction } from "./sqlite";
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";
import {
  derivedFaceFlags,
  parseRoutes,
  resolveRoutes,
  routesFor,
  serializeRoutes,
  type DerivedFaceFlags,
  type LegacyRouteShape,
  type SurfaceRoutes,
} from "../protocol/surface-routes";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProviderNotFoundError extends Error {
  constructor(public readonly providerId: string) {
    super(`Provider not found: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string | null;
  apiKey: string;
  modelMapping?: Record<string, string>;
  /**
   * Typed from the schema that validates it, not spelled out again.
   *
   * Spelled out here this block was the sixth copy of the same field list, and
   * copies drift: this one had already lost `reasoningLevels` while every route
   * that writes through it still offers the field. A field the repository
   * cannot name is a field it drops.
   */
  modelConfigs?: Record<string, ModelConfigPatch>;
  enabled?: boolean;
  priority?: number;
  headers?: Record<string, string>;
  upstreamFormat?: "responses" | "chat" | "anthropic" | "gemini";
  /** OpenAI-side face (Responses/Chat). Defaults to on. */
  openaiEnabled?: boolean;
  /** Anthropic Messages face, sharing this provider's key and models. */
  anthropicEnabled?: boolean;
  /** Base URL for the Anthropic face; empty derives it from `baseUrl`. */
  anthropicBaseUrl?: string | null;
  /**
   * How the Anthropic face is served: the vendor's own `/v1/messages`, or the
   * gateway's translation. Defaults to `native`, which is what the face has
   * always meant.
   */
  anthropicMode?: "native" | "translated";
  /**
   * One protocol document per compatibility interface. An empty list is the
   * default and means "forward the client's request as sent" — so a new
   * provider needs none of this to be a working one.
   */
  textSpecs?: string[];
  /**
   * Which configuration is live. Omitted means "whatever it has always done":
   * `activeModeOf` reads an absent value as advanced-when-there-are-rules.
   */
  activeMode?: "simple" | "advanced" | null;
  /**
   * How each client surface reaches this provider — one entry per surface.
   * Empty means "this row predates the table", and the older columns are read
   * instead.
   */
  surfaceRoutes?: string[];
  /**
   * Which configuration is in effect. Omitted means "whatever it has always
   * done".
   */
  protocolMode?: "simple" | "advanced" | "passthrough" | null;
  /** The dialects the vendor's own API speaks. Advanced mode reads it. */
  upstreamDialects?: string[];
}

export interface UpdateProviderInput {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string | null;
  apiKey?: string;
  modelMapping?: Record<string, string>;
  modelConfigs?: Record<string, ModelConfigPatch>;
  enabled?: boolean;
  priority?: number;
  headers?: Record<string, string>;
  upstreamFormat?: "responses" | "chat" | "anthropic" | "gemini";
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicBaseUrl?: string | null;
  /** How the Anthropic face is served. Defaults to `native`. */
  anthropicMode?: "native" | "translated";
  /**
   * One protocol document per compatibility interface. An empty list is the
   * default and means "forward the client's request as sent" — which is also how
   * every protocol is removed.
   */
  textSpecs?: string[];
  /**
   * Which configuration is live. `undefined` leaves the stored choice alone; an
   * explicit `null` hands the row back to "follow the rules if it has any",
   * which is what a row written before the field existed reads as.
   */
  activeMode?: "simple" | "advanced" | null;
  /**
   * How each client surface reaches this provider — one entry per surface.
   * Empty means "this row predates the table", and the older columns are read
   * instead.
   */
  surfaceRoutes?: string[];
  /**
   * Which configuration is in effect. `undefined` leaves the stored choice
   * alone; an explicit `null` hands the row back to "whatever it has always
   * done".
   */
  protocolMode?: "simple" | "advanced" | "passthrough" | null;
  /** The dialects the vendor's own API speaks. Advanced mode reads it. */
  upstreamDialects?: string[];
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * The routing a row ends up with, and the columns that summarise it.
 *
 * **The route table is the answer.** The columns that came before it are
 * derived from it and are never written by hand, so the two cannot disagree —
 * whichever way the writer phrased the routing. A writer that only knows the
 * old vocabulary (the assistant does) still lands on a table, because
 * {@link resolveRoutes} folds the two together.
 *
 * **What the writer said now decides.** A writer that mentions the old
 * columns is changing the routing, and the table the row happened to have must
 * not outvote it — that is how the assistant's changes to a provider's
 * protocol were saved and then ignored. A writer that says nothing about the
 * routing keeps the row's current answer.
 */
function resolveRowRouting(input: {
  /** The table the writer gave. Undefined: the writer said nothing about it. */
  routes?: readonly string[] | null;
  /** The mode the writer gave. Undefined: the writer said nothing about it. */
  protocolMode?: string | null;
  /** The dialects the writer gave. */
  upstreamDialects?: readonly string[] | null;
  /** The columns the writer gave. Null: the writer said nothing about them. */
  legacy?: LegacyRouteShape | null;
  /** The row's current answer, kept when the writer said nothing at all. */
  current: SurfaceRoutes | null;
  /** The row's columns, the last resort when it has no table. */
  currentLegacy: LegacyRouteShape;
}): { routes: SurfaceRoutes; flags: DerivedFaceFlags } {
  const routes =
    resolveRoutes({
      routes: input.routes,
      protocolMode: input.protocolMode,
      upstreamDialects: input.upstreamDialects,
      legacy: input.legacy,
    }) ??
    input.current ??
    routesFor(input.currentLegacy, null);
  return { routes, flags: derivedFaceFlags(routes) };
}

export async function createProvider(input: CreateProviderInput): Promise<Provider> {
  const id = generateId();
  const now = new Date().toISOString();
  const encryptedApiKey = encryptSecret(input.apiKey);
  // Absent flags follow the legacy shape: an Anthropic-kind / Anthropic-format
  // provider is Anthropic-only, anything else is OpenAI-only.
  const faceDefaults = defaultFaceFlags(input.kind, input.upstreamFormat ?? "responses");

  /**
   * The routing, and the columns that summarise it.
   *
   * The route table is the answer and the columns are derived from it, so the
   * two cannot disagree — whichever way the writer phrased the routing.
   */
  const legacy: LegacyRouteShape = {
    upstreamFormat: input.upstreamFormat ?? "responses",
    openaiEnabled: input.openaiEnabled ?? faceDefaults.openaiEnabled,
    anthropicEnabled: input.anthropicEnabled ?? faceDefaults.anthropicEnabled,
    anthropicMode: input.anthropicMode ?? "native",
    kind: input.kind,
  };
  const routing = resolveRowRouting({
    routes: input.surfaceRoutes,
    protocolMode: input.protocolMode,
    upstreamDialects: input.upstreamDialects,
    legacy,
    current: null,
    currentLegacy: legacy,
  });

  const provider: Provider = ProviderSchema.parse({
    id,
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl ?? null,
    encryptedApiKey,
    modelMapping: input.modelMapping ?? {},
    modelConfigs: input.modelConfigs ?? {},
    enabled: input.enabled ?? true,
    priority: input.priority ?? 1,
    headers: input.headers ?? {},
    upstreamFormat: routing.flags.upstreamFormat,
    openaiEnabled: routing.flags.openaiEnabled,
    anthropicEnabled: routing.flags.anthropicEnabled,
    anthropicBaseUrl: input.anthropicBaseUrl ?? null,
    // How the Anthropic face is served. Absent means the vendor's own
    // endpoint, which is what the face has always meant.
    anthropicMode: routing.flags.anthropicMode,
    textSpecs: input.textSpecs ?? [],
    activeMode: input.activeMode ?? null,
    surfaceRoutes: serializeRoutes(routing.routes),
    protocolMode: input.protocolMode ?? null,
    upstreamDialects: input.upstreamDialects ?? [],
    createdAt: now,
    updatedAt: now,
  });

  // NULL is now a real value rather than a stand-in for "empty string": the
  // Redis hash stored `baseUrl: ""` and `anthropicBaseUrl: ""` and the reader
  // translated "" back to null, so an intentionally blank URL and an absent
  // one were indistinguishable in the store.
  run(
    `INSERT INTO providers
       (id, name, kind, base_url, encrypted_api_key, model_mapping,
        model_configs, enabled, priority, headers, upstream_format,
        openai_enabled, anthropic_enabled, anthropic_base_url, anthropic_mode,
        text_specs, active_mode, surface_routes, protocol_mode,
        upstream_dialects, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      provider.id,
      provider.name,
      provider.kind,
      // `node:sqlite` refuses to bind `undefined` ("Provided value cannot be
      // bound to SQLite parameter 4"), and a provider is legitimately created
      // with only a key pasted in — the base URL is filled in afterwards from
      // the admin panel. NULL is the column's "not configured yet".
      provider.baseUrl ?? null,
      provider.encryptedApiKey,
      JSON.stringify(provider.modelMapping),
      JSON.stringify(provider.modelConfigs ?? {}),
      toDbBool(provider.enabled),
      provider.priority,
      JSON.stringify(provider.headers ?? {}),
      provider.upstreamFormat,
      toDbBool(provider.openaiEnabled),
      toDbBool(provider.anthropicEnabled),
      provider.anthropicBaseUrl ?? null,
      provider.anthropicMode,
      JSON.stringify(provider.textSpecs ?? []),
      provider.activeMode ?? null,
      JSON.stringify(provider.surfaceRoutes ?? []),
      provider.protocolMode ?? null,
      JSON.stringify(provider.upstreamDialects ?? []),
      provider.createdAt,
      provider.updatedAt,
    ],
  );

  // Revalidate the providers cache
  revalidateTag("providers");

  return provider;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Look up a provider by id. Returns null if not found. */
export async function getProviderById(id: string): Promise<Provider | null> {
  if (!id) return null;
  return getOne("SELECT * FROM providers WHERE id = ?", [id], rowToProvider);
}

/**
 * Un-cached provider read: one indexed SELECT.
 *
 * Ordering is the same contract the Redis version had to build in JS after
 * collecting SCAN results — priority ascending, then name — because callers
 * pick the first match when routing a model. Only the tiebreak between equal
 * priorities differs: SQLite compares `name` by code point where the old code
 * used `localeCompare`, so non-ASCII display names may order differently.
 * `priority` still decides which provider actually serves a request.
 */
function readProviders(enabledOnly: boolean): Provider[] {
  return getAll(
    enabledOnly
      ? "SELECT * FROM providers WHERE enabled = 1 ORDER BY priority ASC, name ASC"
      : "SELECT * FROM providers ORDER BY priority ASC, name ASC",
    [],
    rowToProvider,
  );
}

/**
 * `listProviders` sits on the hot path of every proxied request (it resolves
 * which upstream serves a model). Provider config changes rarely, so the
 * `unstable_cache` wrapper and the `providers` tag that create/update/delete
 * already fire are kept as they are — they cost nothing over a local file and
 * still absorb the repeated calls made while picking a failover target.
 */
const listProvidersCached = unstable_cache(
  async (enabledOnly: boolean) => readProviders(enabledOnly),
  ["relayab:listProviders"],
  { tags: ["providers"], revalidate: 60 },
);

/** List all providers (sorted by priority ascending, then by name). */
export async function listProviders(opts: {
  enabledOnly?: boolean;
} = {}): Promise<Provider[]> {
  return listProvidersCached(Boolean(opts.enabledOnly));
}

/**
 * Find providers that can serve the given client-visible model.
 *
 * The Redis version SCANned every provider and then tested `clientModel in
 * modelMapping` row by row. There is no index to make that selective — the
 * mapping is a JSON object read whole and written whole — so the same
 * "load the enabled set, filter it" shape is kept deliberately: provider
 * count is small, and routing already needs the full row to build the
 * upstream request. Row order is the priority order from `listProviders`.
 */
export async function findProvidersForModel(clientModel: string): Promise<Provider[]> {
  const all = await listProviders({ enabledOnly: true });
  return all.filter((p) => clientModel in p.modelMapping);
}

/**
 * Providers that can serve `clientModel` on the OpenAI-facing endpoints
 * (`/v1/chat/completions`, `/v1/responses`).
 *
 * A provider with `upstreamFormat: "anthropic"` is Anthropic-only, and one with
 * `openaiEnabled: false` opted out — both are excluded here even though they
 * still map the model on their Anthropic face.
 */
export async function findOpenAIProvidersForModel(clientModel: string): Promise<Provider[]> {
  const all = await findProvidersForModel(clientModel);
  return all.filter((p) => providerFaces(p).openai !== null);
}

/**
 * The OpenAI-facing providers for a model, read without the cache.
 *
 * The same rows as {@link findOpenAIProvidersForModel}, read the other way.
 * The cached reader needs a request to live in — the cache is a request scope,
 * and calling it outside one throws — and the realtime bridge is called from
 * the custom server's upgrade handler, which is not a request. It is the one
 * caller outside a request, and it is the reason this exists.
 */
export function findOpenAIProvidersForModelUncached(clientModel: string): Provider[] {
  return readProviders(true).filter(
    (p) => clientModel in p.modelMapping && providerFaces(p).openai !== null,
  );
}

/**
 * Providers that can serve `clientModel` on the Anthropic Messages surface.
 *
 * The key, model mapping and model configs come from the same row as the
 * OpenAI face, so a vendor configured once serves both protocols.
 */
export async function findAnthropicProvidersForModel(clientModel: string): Promise<Provider[]> {
  const all = await findProvidersForModel(clientModel);
  return all.filter((p) => providerFaces(p).anthropic !== null);
}

/** Find providers of a given kind. */
export async function findProvidersByKind(kind: ProviderKind): Promise<Provider[]> {
  const all = await listProviders({ enabledOnly: true });
  return all.filter((p) => p.kind === kind);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Apply a partial patch to a provider. Returns the updated provider, or null
 * if not found.
 *
 * The merge is a read-modify-write, so it runs inside one IMMEDIATE
 * transaction: the Redis version did HGETALL → HSET with nothing holding a
 * lock between the two, and two concurrent admin edits could drop one of the
 * changes. Nested callers join the surrounding transaction instead of failing.
 */
export async function updateProvider(
  id: string,
  patch: UpdateProviderInput,
): Promise<Provider | null> {
  return withTransaction(async () => {
    const existing = await getProviderById(id);
    if (!existing) return null;

    const encryptedApiKey = patch.apiKey
      ? encryptSecret(patch.apiKey)
      : existing.encryptedApiKey;

    /**
     * The routing, and the columns that summarise it.
     *
     * The route table is the answer and the columns are derived from it, so the
     * two cannot disagree — whichever way the writer phrased the routing. That
     * includes the writer who only knows the columns that came before the
     * table: the assistant's tools speak that vocabulary, and before this their
     * changes were saved and then **ignored**, because the table won.
     *
     * A patch that says nothing about the routing keeps the row's current
     * answer.
     */
    const legacyPatched =
      patch.upstreamFormat !== undefined ||
      patch.openaiEnabled !== undefined ||
      patch.anthropicEnabled !== undefined ||
      patch.anthropicMode !== undefined;
    const routing = resolveRowRouting({
      routes: patch.surfaceRoutes,
      protocolMode: patch.protocolMode,
      upstreamDialects: patch.upstreamDialects,
      legacy: legacyPatched
        ? {
            upstreamFormat: patch.upstreamFormat ?? existing.upstreamFormat,
            openaiEnabled: patch.openaiEnabled ?? existing.openaiEnabled,
            anthropicEnabled: patch.anthropicEnabled ?? existing.anthropicEnabled,
            anthropicMode: patch.anthropicMode ?? existing.anthropicMode,
            kind: patch.kind ?? existing.kind,
          }
        : null,
      current: parseRoutes(existing.surfaceRoutes ?? []),
      currentLegacy: {
        upstreamFormat: existing.upstreamFormat,
        openaiEnabled: existing.openaiEnabled,
        anthropicEnabled: existing.anthropicEnabled,
        anthropicMode: existing.anthropicMode,
        kind: existing.kind,
      },
    });

    const merged: Provider = ProviderSchema.parse({
      ...existing,
      name: patch.name ?? existing.name,
      kind: patch.kind ?? existing.kind,
      baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
      encryptedApiKey,
      modelMapping: patch.modelMapping ?? existing.modelMapping,
      modelConfigs: patch.modelConfigs ?? existing.modelConfigs,
      enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
      priority: patch.priority ?? existing.priority,
      headers: patch.headers ?? existing.headers,
      upstreamFormat: routing.flags.upstreamFormat,
      openaiEnabled: routing.flags.openaiEnabled,
      anthropicEnabled: routing.flags.anthropicEnabled,
      anthropicBaseUrl:
        patch.anthropicBaseUrl === undefined
          ? existing.anthropicBaseUrl
          : patch.anthropicBaseUrl,
      // `undefined` means "leave it alone"; an explicit `null` is how the
      // background page says "no protocol, forward everything as sent".
      textSpecs: patch.textSpecs ?? existing.textSpecs ?? [],
      // `undefined` leaves the choice as it is, which is how a PATCH that only
      // touches the name does not silently reset it.
      activeMode: patch.activeMode === undefined ? existing.activeMode : patch.activeMode,
      // The table is written whole, every time. It is the answer, and a row
      // whose every surface is switched off has to be able to say so.
      surfaceRoutes: serializeRoutes(routing.routes),
      protocolMode:
        patch.protocolMode === undefined ? existing.protocolMode : patch.protocolMode,
      upstreamDialects:
        patch.upstreamDialects === undefined
          ? existing.upstreamDialects ?? []
          : patch.upstreamDialects,
      updatedAt: new Date().toISOString(),
    });

    // Every column is written, not just the patched ones: the entity is the
    // authority on the merged state, and one whole-row UPDATE is atomic in SQL
    // whereas a partial HSET in Redis could interleave with another writer.
    run(
      `UPDATE providers SET
         name = ?, kind = ?, base_url = ?, encrypted_api_key = ?,
         model_mapping = ?, model_configs = ?, enabled = ?, priority = ?,
         headers = ?, upstream_format = ?, openai_enabled = ?,
         anthropic_enabled = ?, anthropic_base_url = ?, anthropic_mode = ?,
         text_specs = ?, active_mode = ?, surface_routes = ?, protocol_mode = ?,
         upstream_dialects = ?, updated_at = ?
       WHERE id = ?`,
      [
        merged.name,
        merged.kind,
        merged.baseUrl,
        merged.encryptedApiKey,
        JSON.stringify(merged.modelMapping),
        JSON.stringify(merged.modelConfigs ?? {}),
        toDbBool(merged.enabled),
        merged.priority,
        JSON.stringify(merged.headers ?? {}),
        merged.upstreamFormat,
        toDbBool(merged.openaiEnabled),
        toDbBool(merged.anthropicEnabled),
        merged.anthropicBaseUrl,
        merged.anthropicMode,
        JSON.stringify(merged.textSpecs ?? []),
        merged.activeMode ?? null,
        JSON.stringify(merged.surfaceRoutes ?? []),
        merged.protocolMode ?? null,
        JSON.stringify(merged.upstreamDialects ?? []),
        merged.updatedAt,
        id,
      ],
    );

    // Revalidate the providers cache
    revalidateTag("providers");

    return merged;
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Hard-delete a provider. Returns false if it did not exist. */
export async function deleteProvider(id: string): Promise<boolean> {
  // The row count of the DELETE is the existence check the Redis version got
  // from a separate HGETALL, so a miss neither writes nor revalidates.
  const removed = run("DELETE FROM providers WHERE id = ?", [id]);
  if (removed === 0) return false;

  // Revalidate the providers cache
  revalidateTag("providers");

  return true;
}

// ---------------------------------------------------------------------------
// Model Config helpers
// ---------------------------------------------------------------------------

/**
 * These read from the entity the caller already holds, not from the database:
 * the proxy resolves a provider, reads its config, and uses it to build the
 * upstream call — a second query would be a pure round trip.
 */

export function getModelConfig(
  provider: Provider,
  clientModelId: string
): ModelConfig | undefined {
  return provider.modelConfigs?.[clientModelId];
}

export function getModelCreditCost(
  provider: Provider,
  clientModelId: string
): {
  inputCost: number;
  outputCost: number;
  /** Resolved, so a caller never has to re-implement the unset fallback. */
  cachedInputCost: number;
  cacheWriteCost: number;
} {
  const config = provider.modelConfigs?.[clientModelId];
  if (!config) {
    return {
      inputCost: 0,
      outputCost: 0,
      cachedInputCost: 0,
      cacheWriteCost: 0,
    };
  }
  return {
    inputCost: config.inputCost,
    outputCost: config.outputCost,
    // Unset means "the same as input", which is the safe answer for a
    // model row written before caching existed.
    cachedInputCost: config.cachedInputCost ?? config.inputCost,
    cacheWriteCost: config.cacheWriteCost ?? config.inputCost,
  };
}

export function getModelContextLength(
  provider: Provider,
  clientModelId: string
): number {
  return provider.modelConfigs?.[clientModelId]?.contextLength ?? 128000;
}
