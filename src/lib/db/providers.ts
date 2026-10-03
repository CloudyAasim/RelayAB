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
} from "./types";
import { revalidateTag, unstable_cache } from "next/cache";
import { getAll, getOne, rowToProvider, run, toDbBool, withTransaction } from "./sqlite";
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";

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
  modelConfigs?: Record<string, {
    upstreamId: string;
    clientId: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    inputCost?: number;
    outputCost?: number;
    enabled?: boolean;
  }>;
  enabled?: boolean;
  priority?: number;
  headers?: Record<string, string>;
  upstreamFormat?: "responses" | "chat" | "anthropic";
  /** OpenAI-side face (Responses/Chat). Defaults to on. */
  openaiEnabled?: boolean;
  /** Anthropic Messages face, sharing this provider's key and models. */
  anthropicEnabled?: boolean;
  /** Base URL for the Anthropic face; empty derives it from `baseUrl`. */
  anthropicBaseUrl?: string | null;
}

export interface UpdateProviderInput {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string | null;
  apiKey?: string;
  modelMapping?: Record<string, string>;
  modelConfigs?: Record<string, {
    upstreamId: string;
    clientId: string;
    displayName?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    inputCost?: number;
    outputCost?: number;
    enabled?: boolean;
  }>;
  enabled?: boolean;
  priority?: number;
  headers?: Record<string, string>;
  upstreamFormat?: "responses" | "chat" | "anthropic";
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicBaseUrl?: string | null;
  /**
   * The wire protocol, as a JSON document. `null` clears it, which puts the
   * provider back to forwarding the client's request as sent.
   */
  textSpec?: string | null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createProvider(input: CreateProviderInput): Promise<Provider> {
  const id = generateId();
  const now = new Date().toISOString();
  const encryptedApiKey = encryptSecret(input.apiKey);
  // Absent flags follow the legacy shape: an Anthropic-kind / Anthropic-format
  // provider is Anthropic-only, anything else is OpenAI-only.
  const faceDefaults = defaultFaceFlags(input.kind, input.upstreamFormat ?? "responses");

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
    upstreamFormat: input.upstreamFormat ?? "responses",
    openaiEnabled: input.openaiEnabled ?? faceDefaults.openaiEnabled,
    anthropicEnabled: input.anthropicEnabled ?? faceDefaults.anthropicEnabled,
    anthropicBaseUrl: input.anthropicBaseUrl ?? null,
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
        openai_enabled, anthropic_enabled, anthropic_base_url,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      upstreamFormat: patch.upstreamFormat ?? existing.upstreamFormat,
      openaiEnabled: patch.openaiEnabled ?? existing.openaiEnabled,
      anthropicEnabled: patch.anthropicEnabled ?? existing.anthropicEnabled,
      anthropicBaseUrl:
        patch.anthropicBaseUrl === undefined
          ? existing.anthropicBaseUrl
          : patch.anthropicBaseUrl,
      // `undefined` means "leave it alone"; an explicit `null` is how the
      // background page says "no protocol, forward everything as sent".
      textSpec: patch.textSpec === undefined ? existing.textSpec : patch.textSpec,
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
         anthropic_enabled = ?, anthropic_base_url = ?, text_spec = ?,
         updated_at = ?
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
        merged.textSpec,
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
): { inputCost: number; outputCost: number } {
  const config = provider.modelConfigs?.[clientModelId];
  if (!config) {
    return { inputCost: 0, outputCost: 0 };
  }
  return {
    inputCost: config.inputCost,
    outputCost: config.outputCost,
  };
}

export function getModelContextLength(
  provider: Provider,
  clientModelId: string
): number {
  return provider.modelConfigs?.[clientModelId]?.contextLength ?? 128000;
}
