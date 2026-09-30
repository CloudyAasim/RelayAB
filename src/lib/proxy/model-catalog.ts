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
 * `https://relay.example.com/anthropic` that request lands on
 * `/anthropic/v1/models`; a 404 there shows up in the editor as "no model
 * could be loaded", not as a visible HTTP error.
 */
import { providerFaces, type ApiKey, type Provider } from "@/lib/db/types";
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import type { MediaProvider, MediaSpec } from "@/lib/media/spec";

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /**
   * Non-standard RelayAB block. OpenAI SDKs ignore unknown fields, but it is
   * what tells a client "this model is for images, it has these sizes, and its
   * edit mode is 'reference' instead of a masked edit".
   */
  relay?: Record<string, unknown>;
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
    // A provider with both protocol faces switched off serves nothing, so its
    // models must not be advertised on either list.
    const faces = providerFaces(provider);
    if (!faces.openai && !faces.anthropic) continue;
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
 * The spec that will actually serve a client model, mirroring the selection the
 * request path performs.
 *
 * A provider can hold specs of several capabilities (AgnesCN has an image spec
 * and a video spec), so "the provider's first spec" is not an answer: it labelled
 * a video model as `image.generate`. Prefer the spec that names the model, then
 * an unscoped spec (which serves every model of its capability), then fall back
 * to the first spec for models no spec claims — which validation already warns
 * about.
 */
function specServingModel(provider: MediaProvider, clientModel: string): MediaSpec | undefined {
  return (
    provider.specs.find((spec) => spec.models?.includes(clientModel)) ??
    provider.specs.find((spec) => !spec.models || spec.models.length === 0) ??
    provider.specs[0]
  );
}

/**
 * Media models visible to one key, annotated so a client can tell them apart
 * from chat models without trial and error.
 *
 * The capability comes from the spec that serves the model, and the rest is that
 * spec's own `metadata` (modes, edit_mode, sizes, max_n) passed through verbatim.
 */
export async function listClientMediaModelEntries(
  key: ApiKey,
  createdAt: number,
): Promise<OpenAIModelEntry[]> {
  const providers = await listMediaProviders({ enabledOnly: true });
  const out: OpenAIModelEntry[] = [];
  for (const provider of providers) {
    for (const [clientModel, model] of Object.entries(provider.models)) {
      if (!model.enabled) continue;
      if (key.allowedModels.length > 0 && !key.allowedModels.includes(clientModel)) continue;
      const spec = specServingModel(provider, clientModel);
      out.push({
        id: clientModel,
        object: "model",
        created: createdAt,
        owned_by: "relayab",
        relay: {
          kind: "media",
          provider: provider.name,
          capability: spec?.capability ?? "image.generate",
          ...(spec?.metadata ?? {}),
        },
      });
    }
  }
  return out;
}

/** Everything a key may call on the OpenAI surface: chat + media. */
export async function listClientModelEntries(key: ApiKey): Promise<OpenAIModelEntry[]> {
  const created = Math.floor(Date.now() / 1000);
  // Tag chat models too, so `relay.kind` is a reliable discriminator rather
  // than "has no relay block, therefore chat".
  const chat = openAIModelList(await listClientModelIds(key), created).map((entry) => ({
    ...entry,
    relay: { kind: "chat" },
  }));
  const media = await listClientMediaModelEntries(key, created);
  return [...chat, ...media];
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
