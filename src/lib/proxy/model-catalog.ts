/**
 * src/lib/proxy/model-catalog.ts
 *
 * One source of truth for "which model ids may this key see?".
 *
 * Both model-listing endpoints ask the same question and must never disagree:
 *
 *   GET /v1/models            → OpenAI shape  (object: "list", data: [...])
 *   GET /anthropic/v1/models  → Anthropic shape (data: [{type:"model", ...}])
 *
 * The Anthropic one exists because ONLYOFFICE's Anthropic provider has no
 * built-in model list — the plugin always issues `GET {url}/{addon}/models`.
 * With the relay's Anthropic surface configured as
 * `https://api.aasim.l.cd/anthropic` that request lands on
 * `/anthropic/v1/models`; a 404 there shows up in the editor as "no model
 * could be loaded", not as a visible HTTP error.
 */
import type { ApiKey, Provider } from "@/lib/db/types";
import { listProviders } from "@/lib/db/providers";

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface AnthropicModelEntry {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
}

/**
 * Provider-facing client model ids visible to one key.
 *
 * A key sees the union of every enabled provider's client-facing model names,
 * narrowed by the key's own whitelist (an empty whitelist means "all").
 */
export function intersectClientModels(providers: Provider[], key: ApiKey): string[] {
  const ids = new Set<string>();
  for (const provider of providers) {
    for (const clientModel of Object.keys(provider.modelMapping)) {
      if (key.allowedModels.length === 0 || key.allowedModels.includes(clientModel)) {
        ids.add(clientModel);
      }
    }
  }
  return Array.from(ids);
}

/** Same as `intersectClientModels`, but loads the enabled providers itself. */
export async function listClientModelIds(key: ApiKey): Promise<string[]> {
  const providers = await listProviders({ enabledOnly: true });
  return intersectClientModels(providers, key);
}

export function openAIModelList(ids: string[], createdAt: number): OpenAIModelEntry[] {
  return ids.map((id) => ({
    id,
    object: "model",
    created: createdAt,
    owned_by: "relayab",
  }));
}

/**
 * Anthropic's list is timestamped as ISO-8601 (`created_at`) and carries a
 * `display_name`; clients that follow the Anthropic SDK shape read those.
 */
export function anthropicModelList(ids: string[], createdAt: Date): AnthropicModelEntry[] {
  const timestamp = createdAt.toISOString();
  return ids.map((id) => ({
    type: "model",
    id,
    display_name: id,
    created_at: timestamp,
  }));
}
