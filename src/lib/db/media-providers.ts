/**
 * src/lib/db/media-providers.ts
 *
 * Repository for **media providers** — vendors that serve image / video /
 * audio / music. They are deliberately a separate entity from chat providers:
 * the request shape, the parameters and the billing unit are all different,
 * and the whole point of the media adapter protocol is that a provider is a
 * base URL + a set of declarative specs, not code.
 *
 * Schema:
 *   TABLE media_providers → one row per provider, `models`/`specs` as JSON text
 *
 * Improvements over the Redis version this replaces:
 * - The `relay:media-provider:index` SET is gone. Maintaining a side index on
 *   every write (SADD on create, SREM on delete) was the only thing keeping it
 *   in step with the record hashes, and it could drift: a crash between the
 *   HSET and the SADD left a provider invisible to `listMediaProviders` with no
 *   way to discover it. A plain `SELECT` cannot drift.
 * - `listMediaProviders` is one query instead of N round trips. It used to
 *   SMEMBERS the index and then HGETALL every id in parallel.
 * - The sort by priority is now part of the query, so it applies to *every*
 *   call. The Redis version only sorted on the unfiltered path and returned
 *   `enabledOnly` results in raw set order.
 * - Reading no longer needs a defensive `hashTo*` deserialiser; the Upstash
 *   client auto-parses JSON-looking hash values, so a single field could come
 *   back as an object, a string or the number 1, and the entity had to accept
 *   all three. `rowToMediaProvider` sees one canonical column type per field.
 * - A corrupt `models`/`specs` column can no longer make an entire provider
 *   vanish from every list, because a row that fails to decode used to be
 *   dropped by the per-record `try/catch`.
 *
 * Specs are validated with `parseMediaSpec` on every write, so a broken spec is
 * rejected in the admin panel rather than on a live request.
 */
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";
import { getAll, getOne, rowToMediaProvider, run, toDbBool } from "./sqlite";
import { parseMediaSpec, validateMediaSpecs, type MediaCapability, type MediaProvider, type MediaSpec, type PublicMediaProvider } from "../media/spec";

export interface CreateMediaProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
  priority?: number;
  models?: MediaProvider["models"];
  specs?: unknown[];
}

export interface UpdateMediaProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  models?: MediaProvider["models"];
  specs?: unknown[];
}

export class MediaProviderValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super("Invalid media provider configuration");
    this.name = "MediaProviderValidationError";
  }
}

function toPublic(provider: MediaProvider): PublicMediaProvider {
  const { encryptedApiKey: _unused, ...rest } = provider;
  void _unused;
  return rest;
}

export function toPublicMediaProvider(provider: MediaProvider): PublicMediaProvider {
  return toPublic(provider);
}

function parseSpecs(raw: unknown[]): MediaSpec[] {
  // Cross-spec rules (no two unscoped specs for the same capability) live in
  // `validateMediaSpecs`, so a provider cannot be saved in a state where one
  // spec silently shadows another.
  const { errors } = validateMediaSpecs(raw);
  if (errors.length > 0) throw new MediaProviderValidationError(errors);
  const out: MediaSpec[] = [];
  raw.forEach((entry) => {
    const parsed = parseMediaSpec(entry);
    if (parsed.ok) out.push(parsed.spec);
  });
  return out;
}

export async function createMediaProvider(
  input: CreateMediaProviderInput,
): Promise<MediaProvider> {
  const now = new Date().toISOString();
  const provider: MediaProvider = {
    id: generateId(),
    name: input.name,
    baseUrl: input.baseUrl,
    encryptedApiKey: encryptSecret(input.apiKey),
    enabled: input.enabled ?? true,
    priority: input.priority ?? 1,
    models: input.models ?? {},
    specs: parseSpecs(input.specs ?? []),
    createdAt: now,
    updatedAt: now,
  };

  // One statement, where the Redis version needed a MULTI wrapping an HSET and
  // an SADD. There is no secondary index left to keep in step, so a partially
  // applied create is no longer representable.
  run(
    `INSERT INTO media_providers
       (id, name, base_url, encrypted_api_key, enabled, priority, models, specs, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      provider.id,
      provider.name,
      provider.baseUrl,
      provider.encryptedApiKey,
      toDbBool(provider.enabled),
      provider.priority,
      JSON.stringify(provider.models),
      JSON.stringify(provider.specs),
      provider.createdAt,
      provider.updatedAt,
    ],
  );
  return provider;
}

export async function updateMediaProvider(
  id: string,
  patch: UpdateMediaProviderInput,
): Promise<MediaProvider | null> {
  const existing = await getMediaProviderById(id);
  if (!existing) return null;

  const merged: MediaProvider = {
    ...existing,
    name: patch.name ?? existing.name,
    baseUrl: patch.baseUrl ?? existing.baseUrl,
    encryptedApiKey: patch.apiKey ? encryptSecret(patch.apiKey) : existing.encryptedApiKey,
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    priority: patch.priority ?? existing.priority,
    models: patch.models ?? existing.models,
    specs: patch.specs === undefined ? existing.specs : parseSpecs(patch.specs),
    updatedAt: new Date().toISOString(),
  };

  // Full-row UPDATE rather than Redis's partial HSET: every mutable column is
  // derived from `merged`, so the two write paths cannot disagree about which
  // fields are writable. It is one statement, so a reader never observes a
  // half-updated provider.
  run(
    `UPDATE media_providers SET
       name = ?, base_url = ?, encrypted_api_key = ?, enabled = ?,
       priority = ?, models = ?, specs = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.name,
      merged.baseUrl,
      merged.encryptedApiKey,
      toDbBool(merged.enabled),
      merged.priority,
      JSON.stringify(merged.models),
      JSON.stringify(merged.specs),
      merged.updatedAt,
      id,
    ],
  );
  return merged;
}

export async function getMediaProviderById(id: string): Promise<MediaProvider | null> {
  if (!id) return null;
  // A missing row is null on its own; the Redis version had to infer "absent"
  // from an empty HGETALL result and then guess the field defaults.
  return getOne("SELECT * FROM media_providers WHERE id = ?", [id], rowToMediaProvider);
}

export async function listMediaProviders(
  opts: { enabledOnly?: boolean } = {},
): Promise<MediaProvider[]> {
  // `enabledOnly` is a WHERE clause rather than a filter over already-fetched
  // rows, and priority ordering now applies to both branches. The Redis
  // version returned the enabled-only list in whatever order the id set
  // happened to enumerate, which left callers to re-sort defensively.
  return opts.enabledOnly
    ? getAll(
        "SELECT * FROM media_providers WHERE enabled = 1 ORDER BY priority ASC",
        [],
        rowToMediaProvider,
      )
    : getAll("SELECT * FROM media_providers ORDER BY priority ASC", [], rowToMediaProvider);
}

export async function deleteMediaProvider(id: string): Promise<boolean> {
  // Existence is the affected-row count, so the read-then-delete pair the Redis
  // version needed (HGETALL to distinguish "gone" from "deleted") collapses into
  // the statement itself — and cannot report success for a row it did not
  // delete.
  return run("DELETE FROM media_providers WHERE id = ?", [id]) > 0;
}

/**
 * Resolve a client-facing media model name to a provider + its model row.
 * Providers are consulted in priority order (ascending, then name), matching
 * how the chat proxy picks a provider for a model.
 */
export async function resolveMediaProviderForModel(
  clientModel: string,
): Promise<{ provider: MediaProvider; upstreamId: string; pricePerItem: number } | null> {
  const providers = await listMediaProviders({ enabledOnly: true });
  for (const provider of providers.sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  )) {
    const model = provider.models[clientModel];
    if (model && model.enabled) {
      return { provider, upstreamId: model.upstreamId, pricePerItem: model.pricePerItem };
    }
  }
  return null;
}

export function pickSpec(
  provider: MediaProvider,
  capability: string,
): MediaSpec | null {
  return provider.specs.find((spec) => spec.capability === capability) ?? null;
}

/**
 * Spec that serves a specific client model.
 *
 * A provider may hold several specs of the same capability when the vendor
 * ships more than one API version (MiniMax video V1 vs V2). Those specs declare
 * `models`, and the model decides which one runs — without it, capability alone
 * would silently send a v2 model to the v1 endpoint.
 */
export function pickSpecForModel(
  provider: MediaProvider,
  capability: string,
  clientModel: string,
): MediaSpec | null {
  const candidates = provider.specs.filter((spec) => spec.capability === capability);
  if (candidates.length === 0) return null;
  const scoped = candidates.find((spec) => spec.models?.includes(clientModel));
  if (scoped) return scoped;
  // A spec that does not declare `models` serves every model of its capability.
  return candidates.find((spec) => !spec.models || spec.models.length === 0) ?? null;
}

/**
 * Spec that serves a request, allowing an image-to-image model to be reached
 * through a provider whose single `image.generate` spec also declares
 * `modes: ["image-to-image"]` (the MiniMax shape) instead of a second spec.
 */
export function pickSpecForRequest(
  provider: MediaProvider,
  capability: MediaCapability,
  clientModel: string,
): MediaSpec | null {
  const exact = pickSpecForModel(provider, capability, clientModel);
  if (exact) return exact;
  if (capability !== "image.edit") return null;
  return (
    provider.specs.find((spec) => {
      const modes = spec.metadata?.modes;
      return Array.isArray(modes) && modes.includes("image-to-image");
    }) ?? null
  );
}
