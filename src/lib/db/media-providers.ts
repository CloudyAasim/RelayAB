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
 *   HASH  relay:media-provider:{id}  → MediaProvider fields
 *   HASH  relay:media-provider:index → SET of provider ids
 *
 * Specs are validated with `parseMediaSpec` on every write, so a broken spec is
 * rejected in the admin panel rather than on a live request.
 */
import { encryptSecret } from "../crypto/secrets";
import { generateId } from "../crypto/hashing";
import { getRedis } from "./redis";
import { parseMediaSpec, type MediaCapability, type MediaProvider, type MediaSpec, type PublicMediaProvider } from "../media/spec";

const ID_KEY = (id: string) => `relay:media-provider:${id}`;
const INDEX_KEY = "relay:media-provider:index";

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
  const out: MediaSpec[] = [];
  const issues: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseMediaSpec(entry);
    if (parsed.ok) {
      out.push(parsed.spec);
    } else {
      issues.push(`specs[${index}]: ${parsed.errors.join("; ")}`);
    }
  });
  if (issues.length > 0) throw new MediaProviderValidationError(issues);
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

  const redis = getRedis();
  const tx = redis.multi();
  tx.hset(ID_KEY(provider.id), {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    encryptedApiKey: provider.encryptedApiKey,
    enabled: provider.enabled ? "1" : "0",
    priority: String(provider.priority),
    models: JSON.stringify(provider.models),
    specs: JSON.stringify(provider.specs),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  });
  tx.sadd(INDEX_KEY, provider.id);
  await tx.exec();
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

  await getRedis().hset(ID_KEY(id), {
    name: merged.name,
    baseUrl: merged.baseUrl,
    encryptedApiKey: merged.encryptedApiKey,
    enabled: merged.enabled ? "1" : "0",
    priority: String(merged.priority),
    models: JSON.stringify(merged.models),
    specs: JSON.stringify(merged.specs),
    updatedAt: merged.updatedAt,
  });
  return merged;
}

export async function getMediaProviderById(id: string): Promise<MediaProvider | null> {
  if (!id) return null;
  const raw = await getRedis().hgetall<Record<string, string>>(ID_KEY(id));
  return hashToMediaProvider(raw);
}

export async function listMediaProviders(
  opts: { enabledOnly?: boolean } = {},
): Promise<MediaProvider[]> {
  const ids = await getRedis().smembers(INDEX_KEY);
  const rows = await Promise.all(ids.map((id) => getMediaProviderById(id)));
  const out = rows.filter((row): row is MediaProvider => row !== null);
  if (opts.enabledOnly) {
    return out.filter((provider) => provider.enabled);
  }
  return out.sort((a, b) => a.priority - b.priority);
}

export async function deleteMediaProvider(id: string): Promise<boolean> {
  const existing = await getMediaProviderById(id);
  if (!existing) return false;
  const tx = getRedis().multi();
  tx.del(ID_KEY(id));
  tx.srem(INDEX_KEY, id);
  await tx.exec();
  return true;
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
 * Spec that serves a request, allowing an image-to-image model to be reached
 * through a provider whose single `image.generate` spec also declares
 * `modes: ["image-to-image"]` (the MiniMax shape) instead of a second spec.
 */
export function pickSpecForRequest(
  provider: MediaProvider,
  capability: MediaCapability,
): MediaSpec | null {
  const exact = pickSpec(provider, capability);
  if (exact) return exact;
  if (capability !== "image.edit") return null;
  return (
    provider.specs.find((spec) => {
      const modes = spec.metadata?.modes;
      return Array.isArray(modes) && modes.includes("image-to-image");
    }) ?? null
  );
}

function hashToMediaProvider(
  raw: Record<string, string> | null,
): MediaProvider | null {
  if (!raw || !raw.id) return null;
  try {
    // `@upstash/redis` deserializes JSON-looking hash values on read, so
    // `models`/`specs` come back as objects, not the JSON text we wrote. The
    // in-memory mock reproduces that, so accept both shapes.
    const parseJson = <T>(value: unknown, fallback: T): T => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "object") return value as T;
      if (typeof value !== "string") return fallback;
      try {
        return JSON.parse(value) as T;
      } catch {
        return fallback;
      }
    };
    // Same reason: a "1" written as a string comes back as the number 1.
    const flag = (value: unknown, fallback = false): boolean => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "boolean") return value;
      return value === 1 || value === "1" || value === "true";
    };
    return {
      id: raw.id,
      name: raw.name,
      baseUrl: raw.baseUrl,
      encryptedApiKey: raw.encryptedApiKey,
      enabled: flag(raw.enabled, true),
      priority: Number(raw.priority ?? 1),
      models: parseJson(raw.models, {} as MediaProvider["models"]),
      specs: parseJson<MediaSpec[]>(raw.specs, []),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  } catch {
    return null;
  }
}
