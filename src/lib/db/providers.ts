/**
 * src/lib/db/providers.ts
 *
 * Repository for upstream `Provider` entities. Each Provider is one
 * upstream AI service account (OpenAI, Anthropic, custom endpoint, ...).
 *
 * Schema (mirrors `docs/DATA_MODEL.md` §3):
 *   HASH relay:provider:{providerId} → Provider fields
 *     - encryptedApiKey is AES-256-GCM ciphertext (see `crypto/secrets.ts`)
 *     - modelMapping is JSON-encoded object: client-model → upstream-model
 *
 * Provider credentials are NEVER exposed via toPublicProvider; only the
 * admin web panel can decrypt them (just-in-time when forwarding a request).
 */
import { ProviderSchema, type Provider, type ProviderKind, type ModelConfig } from "./types";
import { revalidateTag } from "next/cache";
import { getRedis, k } from "./redis";
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
  /** Plaintext upstream API key. Will be AES-encrypted before storage. */
  apiKey: string;
  modelMapping?: Record<string, string>;
  /** Model configurations (context length, output, cost) */
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
  /** Optional per-provider HTTP headers (e.g. api-version for Azure). */
  headers?: Record<string, string>;
}

export interface UpdateProviderInput {
  name?: string;
  kind?: ProviderKind;
  baseUrl?: string | null;
  /** Plaintext upstream API key (re-encrypts). */
  apiKey?: string;
  modelMapping?: Record<string, string>;
  enabled?: boolean;
  priority?: number;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createProvider(input: CreateProviderInput): Promise<Provider> {
  const id = generateId();
  const now = new Date().toISOString();
  const encryptedApiKey = encryptSecret(input.apiKey);

  const provider: Provider = ProviderSchema.parse({
    id,
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl ?? null,
    encryptedApiKey,
    modelMapping: input.modelMapping ?? {},
    enabled: input.enabled ?? true,
    priority: input.priority ?? 1,
    headers: input.headers ?? {},
    createdAt: now,
    updatedAt: now,
  });

  await getRedis().hset(k.provider(id), {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    encryptedApiKey: provider.encryptedApiKey,
    modelMapping: JSON.stringify(provider.modelMapping),
    modelConfigs: JSON.stringify(provider.modelConfigs ?? {}),
    enabled: provider.enabled ? "1" : "0",
    priority: String(provider.priority),
    headers: JSON.stringify(provider.headers ?? {}),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  });

  // Revalidate the providers cache
  revalidateTag("providers");

  return provider;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getProviderById(id: string): Promise<Provider | null> {
  if (!id) return null;
  return hashToProvider(await getRedis().hgetall<Record<string, string>>(k.provider(id)));
}


/** List all providers (sorted by priority ascending, then by name). */
export async function listProviders(opts: {
  enabledOnly?: boolean;
} = {}): Promise<Provider[]> {
  const redis = getRedis();
  const [, matched] = await redis.scan(0, {
    match: `${k.provider("").slice(0, -1)}*`,
    count: 500,
  });
  const keys = matched.filter((key) => key.startsWith(k.provider("")));

  const out: Provider[] = [];
  for (const key of keys) {
    const p = await hashToProvider(await redis.hgetall<Record<string, string>>(key));
    if (!p) continue;
    if (opts.enabledOnly && !p.enabled) continue;
    out.push(p);
  }
  out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Find providers that can serve the given client-visible model.
 * Match = the client's model is a key in the provider's modelMapping.
 */
export async function findProvidersForModel(clientModel: string): Promise<Provider[]> {
  const all = await listProviders({ enabledOnly: true });
  return all.filter((p) => clientModel in p.modelMapping);
}

/** Find providers of a given kind (e.g. "anthropic"). */
export async function findProvidersByKind(kind: ProviderKind): Promise<Provider[]> {
  const all = await listProviders({ enabledOnly: true });
  return all.filter((p) => p.kind === kind);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateProvider(
  id: string,
  patch: UpdateProviderInput,
): Promise<Provider | null> {
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
    enabled: patch.enabled === undefined ? existing.enabled : patch.enabled,
    priority: patch.priority ?? existing.priority,
    headers: patch.headers ?? existing.headers,
    updatedAt: new Date().toISOString(),
  });

  await getRedis().hset(k.provider(id), {
    name: merged.name,
    kind: merged.kind,
    baseUrl: merged.baseUrl ?? "",
    encryptedApiKey: merged.encryptedApiKey,
    modelMapping: JSON.stringify(merged.modelMapping),
    enabled: merged.enabled ? "1" : "0",
    priority: String(merged.priority),
    headers: JSON.stringify(merged.headers ?? {}),
    updatedAt: merged.updatedAt,
  });

  // Revalidate the providers cache
  revalidateTag("providers");

  return merged;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteProvider(id: string): Promise<boolean> {
  const existing = await getProviderById(id);
  if (!existing) return false;
  await getRedis().del(k.provider(id));
  
  // Revalidate the providers cache
  revalidateTag("providers");
  
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashToProvider(raw: Record<string, string> | null): Promise<Provider | null> {
  if (!raw) return null;
  try {
    return ProviderSchema.parse({
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      baseUrl: raw.baseUrl && raw.baseUrl !== "" ? raw.baseUrl : null,
      encryptedApiKey: raw.encryptedApiKey,
      modelMapping: raw.modelMapping ? JSON.parse(raw.modelMapping) : {},
      modelConfigs: raw.modelConfigs ? JSON.parse(raw.modelConfigs) : {},
      enabled: raw.enabled === "1",
      priority: Number(raw.priority ?? "1"),
      headers: raw.headers ? JSON.parse(raw.headers) : {},
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model Config helpers
// ---------------------------------------------------------------------------

/**
 * Get model configuration for a specific model in a provider.
 */
export function getModelConfig(
  provider: Provider,
  clientModelId: string
): ModelConfig | undefined {
  return provider.modelConfigs?.[clientModelId];
}

/**
 * Get credit cost for a model. Returns default values if not configured.
 */
export function getModelCreditCost(
  provider: Provider,
  clientModelId: string
): { inputCost: number; outputCost: number } {
  const config = provider.modelConfigs?.[clientModelId];
  if (!config) {
    // Default costs if not configured
    return { inputCost: 0, outputCost: 0 };
  }
  return {
    inputCost: config.inputCost,
    outputCost: config.outputCost,
  };
}

/**
 * Get context length for a model. Returns default if not configured.
 */
export function getModelContextLength(
  provider: Provider,
  clientModelId: string
): number {
  return provider.modelConfigs?.[clientModelId]?.contextLength ?? 128000;
}
