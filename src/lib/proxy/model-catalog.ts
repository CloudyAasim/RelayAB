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
import { providerFaces, type ApiKey, type Provider, type User } from "@/lib/db/types";
import { listProviders } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { modelAllowedFor } from "@/lib/auth/model-access";
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
 * narrowed by the account owner's whitelist and then by the key's own. An
 * empty whitelist at either level means "no additional restriction here".
 *
 * The owner is part of the answer because the proxy enforces it: a client that
 * is shown a model the owner may not call picks it, calls it, and is refused
 * with `403 model_not_allowed`. Advertising exactly what can be called is the
 * only way the list and the enforcement agree.
 */
export function intersectClientModels(
  providers: Provider[],
  key: ApiKey,
  owner?: User | null,
): string[] {
  const ids = new Set<string>();
  for (const provider of providers) {
    // A provider with both protocol faces switched off serves nothing, so its
    // models must not be advertised on either list.
    const faces = providerFaces(provider);
    if (!faces.openai && !faces.anthropic) continue;
    for (const clientModel of Object.keys(provider.modelMapping)) {
      if (modelAllowedFor(clientModel, key, owner)) {
        ids.add(clientModel);
      }
    }
  }
  return Array.from(ids);
}

/** Same as `intersectClientModels`, but loads the enabled providers itself. */
export async function listClientModelIds(
  key: ApiKey,
  owner?: User | null,
): Promise<string[]> {
  const providers = await listProviders({ enabledOnly: true });
  return intersectClientModels(providers, key, owner);
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
  owner?: User | null,
): Promise<OpenAIModelEntry[]> {
  const mediaProviders = await listMediaProviders({ enabledOnly: true });
  const out: OpenAIModelEntry[] = [];
  for (const provider of mediaProviders) {
    for (const [clientModel, model] of Object.entries(provider.models)) {
      if (!model.enabled) continue;
      if (!modelAllowedFor(clientModel, key, owner)) continue;
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
export async function listClientModelEntries(
  key: ApiKey,
  owner?: User | null,
): Promise<OpenAIModelEntry[]> {
  const created = Math.floor(Date.now() / 1000);
  // Tag chat models too, so `relay.kind` is a reliable discriminator rather
  // than "has no relay block, therefore chat".
  const chat = openAIModelList(await listClientModelIds(key, owner), created).map((entry) => ({
    ...entry,
    relay: { kind: "chat" },
  }));
  const media = await listClientMediaModelEntries(key, created, owner);
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

/**
 * Google's list names the model `models/<id>` and carries the token limits,
 * which the Gemini SDKs read to size a request before sending it.
 */
export interface GeminiModelEntry {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
}

/** One model a key may call, with the limits the operator declared for it. */
export interface ClientModelDetail {
  id: string;
  contextLength: number;
  maxOutputTokens: number;
}

/**
 * The models a key may call, with their limits.
 *
 * The same question as {@link intersectClientModels} — and it must never
 * disagree with it — but with the model's own numbers attached, which the
 * Gemini list needs and the OpenAI one does not.
 *
 * The defaults are the ones the model editor uses for a row that says nothing:
 * a model with no declared limits is not a model without limits, and a list
 * that said so would be a claim rather than a fact.
 */
export async function listClientModelDetails(
  key: ApiKey,
  owner?: User | null,
): Promise<ClientModelDetail[]> {
  const providers = await listProviders({ enabledOnly: true });
  const out: ClientModelDetail[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const faces = providerFaces(provider);
    if (!faces.openai && !faces.anthropic) continue;
    for (const clientId of Object.keys(provider.modelMapping)) {
      if (seen.has(clientId)) continue;
      if (!modelAllowedFor(clientId, key, owner)) continue;
      seen.add(clientId);
      const config = provider.modelConfigs?.[clientId];
      out.push({
        id: clientId,
        contextLength: config?.contextLength ?? DEFAULT_CONTEXT_LENGTH,
        maxOutputTokens: config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      });
    }
  }
  return out;
}

/** The limits a model row that declares none is taken to have. */
const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Gemini's model list.
 *
 * `name` is `models/<id>` — Google's own spelling — because the Gemini SDKs
 * take that name and put it straight into the next request's path.
 */
export function geminiModelList(models: ClientModelDetail[]): GeminiModelEntry[] {
  return models.map((model) => ({
    name: `models/${model.id}`,
    displayName: model.id,
    description: "",
    inputTokenLimit: model.contextLength,
    outputTokenLimit: model.maxOutputTokens,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
  }));
}
