/**
 * src/lib/db/providers.ts
 *
 * Repository for upstream `Provider` entities.
 *
 * Uses Redis SCAN for enumeration - compatible with both Upstash Redis and Vercel KV.
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
import { getRedis, hgetallMany, k, readStoredFlag } from "./redis";
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

  const redis = getRedis();
  
  // Save the provider hash
  await redis.hset(k.provider(id), {
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
    upstreamFormat: provider.upstreamFormat,
    openaiEnabled: provider.openaiEnabled ? "1" : "0",
    anthropicEnabled: provider.anthropicEnabled ? "1" : "0",
    anthropicBaseUrl: provider.anthropicBaseUrl ?? "",
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

/**
 * Un-cached provider read: one SCAN, then one pipelined HGETALL wave.
 */
async function readProviders(enabledOnly: boolean): Promise<Provider[]> {
  const redis = getRedis();

  // Use SCAN to find all provider keys - works with both Upstash Redis and Vercel KV
  const providerIds = await scanProviderIds(redis);

  const rows = await hgetallMany(redis, providerIds.map((id) => k.provider(id)));
  const parsed = await Promise.all(rows.map((raw) => hashToProvider(raw)));

  const out: Provider[] = [];
  for (const p of parsed) {
    if (!p) continue;
    if (enabledOnly && !p.enabled) continue;
    out.push(p);
  }
  out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * `listProviders` sits on the hot path of every proxied request (it resolves
 * which upstream serves a model) and costs a SCAN plus one read per provider.
 * Provider config changes rarely, so cache it and invalidate through the
 * `providers` tag that create/update/delete already fire.
 */
const listProvidersCached = unstable_cache(
  readProviders,
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
 * SCAN through all provider keys. Handles cursor iteration properly.
 * Compatible with both Upstash Redis and Vercel KV.
 */
async function scanProviderIds(redis: { scan: (cursor: any, opts: any) => Promise<[any, string[]]> }): Promise<string[]> {
  const ids: string[] = [];
  const prefix = k.provider(""); // "relay:provider:"
  let cursor = 0;
  
  do {
    const [nextCursor, matched] = await redis.scan(cursor, {
      match: `${prefix}*`,
      count: 100,
    });
    
    for (const key of matched) {
      // Extract ID: "relay:provider:abc123" -> "abc123"
      // Skip "relay:provider:index" which is a SET, not a HASH
      if (key === 'relay:provider:index') continue;
      if (key.startsWith(prefix)) {
        const id = key.slice(prefix.length);
        // Skip non-ID keys (shouldn't happen but be safe)
        if (id && id !== 'index') {
          ids.push(id);
        }
      }
    }
    
    cursor = typeof nextCursor === "number" ? nextCursor : Number(nextCursor);
  } while (cursor !== 0);
  
  return ids;
}

/**
 * Find providers that can serve the given client-visible model.
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
    updatedAt: new Date().toISOString(),
  });

  const redis = getRedis();
  await redis.hset(k.provider(id), {
    name: merged.name,
    kind: merged.kind,
    baseUrl: merged.baseUrl ?? "",
    encryptedApiKey: merged.encryptedApiKey,
    modelMapping: JSON.stringify(merged.modelMapping),
    modelConfigs: JSON.stringify(merged.modelConfigs ?? {}),
    enabled: merged.enabled ? "1" : "0",
    priority: String(merged.priority),
    headers: JSON.stringify(merged.headers ?? {}),
    upstreamFormat: merged.upstreamFormat,
    openaiEnabled: merged.openaiEnabled ? "1" : "0",
    anthropicEnabled: merged.anthropicEnabled ? "1" : "0",
    anthropicBaseUrl: merged.anthropicBaseUrl ?? "",
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

function safeJsonParse(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'object') return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return {}; }
  }
  return {};
}

/**
 * Face flags for a Redis row.
 *
 * Rows written before the two-face model exist without either flag; falling
 * back to the schema defaults would turn an Anthropic-only row
 * (`kind: "anthropic"` / `upstreamFormat: "anthropic"`) into an OpenAI-only one.
 */
function legacyFaceFlags(raw: Record<string, string>): {
  openaiEnabled: boolean;
  anthropicEnabled: boolean;
} {
  if (raw.openaiEnabled !== undefined || raw.anthropicEnabled !== undefined) {
    return {
      openaiEnabled: readStoredFlag(raw.openaiEnabled, true),
      anthropicEnabled: readStoredFlag(raw.anthropicEnabled, false),
    };
  }
  return defaultFaceFlags(
    raw.kind as ProviderKind,
    (raw.upstreamFormat as "responses" | "chat" | "anthropic") || "responses",
  );
}


async function hashToProvider(raw: Record<string, string> | null): Promise<Provider | null> {
  if (!raw || Object.keys(raw).length === 0) return null;
  
  try {
    // Safely parse enabled - handle various formats that might be stored in Redis
    const enabledRaw = raw.enabled;
    let enabled = false;
    if (enabledRaw !== undefined && enabledRaw !== null && enabledRaw !== "") {
      // Handle "1", "true" (case-insensitive), "on" as true
      const normalized = String(enabledRaw).toLowerCase();
      enabled = normalized === "1" || normalized === "true" || normalized === "on";
    }
    
    return ProviderSchema.parse({
      id: raw.id,
      name: raw.name,
      kind: raw.kind,
      baseUrl: raw.baseUrl && raw.baseUrl !== "" ? raw.baseUrl : null,
      encryptedApiKey: raw.encryptedApiKey,
      modelMapping: safeJsonParse(raw.modelMapping),
      modelConfigs: safeJsonParse(raw.modelConfigs),
      enabled,
      priority: Number(raw.priority ?? "1"),
      headers: safeJsonParse(raw.headers),
      upstreamFormat: (raw.upstreamFormat as "responses" | "chat" | "anthropic") || "responses",
      // Absent on rows written before protocol faces existed. Derive from the
      // legacy shape rather than letting the schema default both to
      // "OpenAI-only", which would strip the Anthropic face off every row the
      // old admin UI created via the "Anthropic Messages" format.
      ...legacyFaceFlags(raw),
      anthropicBaseUrl:
        raw.anthropicBaseUrl && raw.anthropicBaseUrl !== "" ? raw.anthropicBaseUrl : null,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
  } catch (err) {
    console.error("[hashToProvider] Failed to parse provider:", err, "Raw keys:", Object.keys(raw), "Raw enabled:", raw?.enabled);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model Config helpers
// ---------------------------------------------------------------------------

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
