/**
 * src/lib/docs/catalog.ts
 *
 * The deployment's model catalogue, as the docs page shows it.
 *
 * One rule shapes the split here, and it is the whole point of the feature:
 *
 *   **Facts come from the gateway. Prose comes from the operator.**
 *
 * A model that exists, its context window, its price and which provider
 * serves it are read live from the provider tables on every request. They
 * cannot be typed into the docs, because a doc that disagrees with the
 * gateway is worse than no doc — a user reads a 1M context window there and
 * then gets a 400 from a 200k model.
 *
 * What an operator *can* set is everything around those numbers: a friendlier
 * display name, a note about when to pick the model, capability tags, and
 * whether to advertise it at all. That is the part no amount of querying the
 * database could ever produce, and the part a reader actually needs.
 */
import { listProviders, getModelCreditCost } from "@/lib/db/providers";
import { listMediaProviders } from "@/lib/db/media-providers";
import { providerFaces } from "@/lib/db/types";
import { getSettings, type ModelNote } from "@/lib/db/settings";
import type { MediaProvider } from "@/lib/media/spec";

export interface CatalogModel {
  /** The client-visible id, exactly as it goes on the wire. */
  id: string;
  kind: "chat" | "media";
  displayName: string;
  provider: string;
  /** Which surface serves it. Media rows name their capability instead. */
  capability: string | null;
  /** Chat only; null when the model is configured but has no declared window. */
  contextLength: number | null;
  maxOutputTokens: number | null;
  /** Credits per 1M tokens, in the same 0.001-credit unit as the rest of the app. */
  inputCost: number | null;
  outputCost: number | null;
  /**
   * Credits per 1M tokens served from the upstream's prompt cache, or null
   * when the rate was never set — which means the cache is charged the input
   * price and there is nothing cheaper to advertise.
   */
  cachedInputCost: number | null;
  /**
   * The thinking levels this model takes, as the vendor published them.
   *
   * Empty for most models, and empty is the honest answer: a vendor publishes
   * levels only for models that think. Carried so the assistant's picker can
   * offer this model's own words instead of a list of four that is wrong for
   * most of them — and a model with none still takes something typed.
   */
  reasoningLevels: string[];
  /**
   * Credits per 1M tokens charged for writing a prompt into the upstream cache,
   * under the same rule as `cachedInputCost`: null means the write is charged the
   * input price and there is no separate number worth showing.
   */
  cacheWriteCost: number | null;
  /** Protocol faces this model is reachable through. */
  faces: string[];
  tags: string[];
  note: string | null;
  /** Operator-configured extras, passed through from the spec's `metadata`. */
  meta: Record<string, unknown>;
  /**
   * The provider that serves this model, in more than its name.
   *
   * A reader picking between two models cannot tell them apart by provider
   * name, which is often the same string twice — `MiniMax` serves the chat
   * models and the media ones, and neither says which base URL, which face, or
   * which of the two is even reachable.
   */
  source: {
    name: string;
    kind: "chat" | "media";
    baseUrl: string | null;
    priority: number | null;
    enabled: boolean;
    /** Chat only: which upstream format the provider speaks. */
    upstreamFormat: string | null;
    /** Media only: the endpoint path the spec posts to. */
    endpoint: string | null;
  };
  /** Media only: the upstream model name, which is rarely the client id. */
  upstreamId: string | null;
  /** Chat only: the display label an operator set for this model. */
  displayLabel: string | null;
}

export interface ModelCatalog {
  models: CatalogModel[];
  chatCount: number;
  mediaCount: number;
  providers: Array<{
    name: string;
    kind: "chat" | "media";
    baseUrl: string | null;
    enabled: boolean;
    modelCount: number;
  }>;
  site: {
    name: string;
    description: string;
    announcement: string;
    supportContact: string;
  };
}

function specFor(provider: MediaProvider, modelId: string) {
  return (
    provider.specs.find((s) => s.models?.includes(modelId)) ??
    provider.specs.find((s) => !s.models || s.models.length === 0) ??
    provider.specs[0]
  );
}

/**
 * Build the catalogue.
 *
 * Read live on every call. A cached catalogue is exactly the failure this
 * feature exists to prevent: an operator adds a model at 10:00 and the docs
 * still say it is not available at 11:00.
 */
export async function buildModelCatalog(): Promise<ModelCatalog> {
  const [providers, mediaProviders, settings] = await Promise.all([
    listProviders(),
    listMediaProviders(),
    getSettings(),
  ]);
  const notes = settings.modelNotes ?? {};

  const applyNote = (id: string, fallback: string): Pick<CatalogModel, "displayName" | "note" | "tags"> => {
    const n: ModelNote = notes[id] ?? {};
    return {
      displayName: n.displayName?.trim() || fallback,
      note: n.note?.trim() || null,
      tags: (n.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 8),
    };
  };

  const isHidden = (id: string): boolean => notes[id]?.hidden === true;

  const models: CatalogModel[] = [];

  for (const provider of providers) {
    const faces = providerFaces(provider);
    const faceNames: string[] = [
      ...(faces.openai ? ["openai"] : []),
      ...(faces.anthropic ? ["anthropic"] : []),
    ];
    // A provider with every face off serves nothing, so listing its models
    // would advertise something that cannot be called.
    if (!provider.enabled || faceNames.length === 0) continue;

    for (const clientId of Object.keys(provider.modelMapping)) {
      if (isHidden(clientId)) continue;
      const cfg = provider.modelConfigs?.[clientId];
      const note = applyNote(clientId, clientId);
      // Read the raw config rather than `getModelContextLength()`, which
      // answers 128_000 for a model that has *declared* nothing. The docs must
      // be able to say "not configured" — printing a guessed window as a fact
      // is precisely the failure this page exists to prevent.
      const cost = cfg ? getModelCreditCost(provider, clientId) : null;
      models.push({
        id: clientId,
        kind: "chat",
        provider: provider.name,
        capability: null,
        contextLength: cfg?.contextLength ?? null,
        maxOutputTokens: cfg?.maxOutputTokens ?? null,
        reasoningLevels: cfg?.reasoningLevels ?? [],
        inputCost: cost ? cost.inputCost : null,
        outputCost: cost ? cost.outputCost : null,
        // Resolved, not raw: unset means "the input price", and the reader
        // needs to know whether there is a cheaper number to show, not
        // whether the field happened to be blank.
        cachedInputCost:
          cost && cost.cachedInputCost !== undefined && cost.cachedInputCost !== cost.inputCost
            ? cost.cachedInputCost
            : null,
        // Same rule, and it needs saying because the two are charged differently
        // by most vendors: a read is usually a tenth of the input price, a write
        // is usually a premium on it. Collapsing them would understate the write.
        cacheWriteCost:
          cost && cost.cacheWriteCost !== undefined && cost.cacheWriteCost !== cost.inputCost
            ? cost.cacheWriteCost
            : null,
        faces: faceNames,
        ...note,
        meta: {},
        source: {
          name: provider.name,
          kind: "chat",
          baseUrl: provider.baseUrl ?? null,
          priority: provider.priority,
          enabled: provider.enabled,
          upstreamFormat: provider.upstreamFormat,
          endpoint: null,
        },
        // Chat models are their own upstream name unless a mapping says
        // otherwise, so the client id is the honest answer and the mapped one
        // is the useful one.
        upstreamId: provider.modelMapping[clientId] ?? null,
        displayLabel: cfg?.displayName?.trim() || null,
      });
    }
  }

  for (const provider of mediaProviders) {
    if (!provider.enabled) continue;
    for (const [clientId, model] of Object.entries(provider.models)) {
      if (model.enabled === false) continue;
      if (isHidden(clientId)) continue;
      const spec = specFor(provider, clientId);
      const note = applyNote(clientId, clientId);
      models.push({
        id: clientId,
        kind: "media",
        provider: provider.name,
        capability: spec?.capability ?? null,
        // Media endpoints have no token window; the interesting parameters are
        // the ones the spec advertises (sizes, modes, max_n).
        contextLength: null,
        maxOutputTokens: null,
        cachedInputCost: null,
        cacheWriteCost: null,
        reasoningLevels: [],
        inputCost:
          typeof (model as { pricePerItem?: unknown }).pricePerItem === "number"
            ? (model as { pricePerItem: number }).pricePerItem
            : null,
        outputCost: null,
        faces: spec ? [spec.capability] : [],
        ...note,
        meta: (spec?.metadata ?? {}) as Record<string, unknown>,
        source: {
          name: provider.name,
          kind: "media",
          baseUrl: provider.baseUrl ?? null,
          priority: provider.priority,
          enabled: provider.enabled,
          upstreamFormat: null,
          // The path the spec posts to. For a reader choosing between two
          // providers this is the difference between "same vendor" and "one
          // speaks /v1/image_generation, the other something else".
          endpoint: spec?.transport?.path ?? null,
        },
        upstreamId: (model as { upstreamId?: string }).upstreamId ?? null,
        displayLabel: null,
      });
    }
  }

  // Newest and longest-context first, so the page opens on what matters.
  models.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "chat" ? -1 : 1;
    const byContext = (b.contextLength ?? 0) - (a.contextLength ?? 0);
    if (byContext !== 0) return byContext;
    return a.id.localeCompare(b.id);
  });

  return {
    models,
    chatCount: models.filter((m) => m.kind === "chat").length,
    mediaCount: models.filter((m) => m.kind === "media").length,
    providers: [
      ...providers.map((p) => ({
        name: p.name,
        // The kind is what lets the docs list "MiniMax" twice — once for the
        // chat models, once for the media ones. Merged, they are two different
        // things behind one name, and a reader cannot tell which serves what.
        kind: "chat" as const,
        baseUrl: p.baseUrl ?? null,
        enabled: p.enabled,
        modelCount: Object.keys(p.modelMapping ?? {}).length,
      })),
      ...mediaProviders.map((p) => ({
        name: p.name,
        kind: "media" as const,
        baseUrl: p.baseUrl ?? null,
        enabled: p.enabled,
        modelCount: Object.keys(p.models ?? {}).length,
      })),
    ],
    site: {
      name: settings.siteName?.trim() || "RelayAB",
      description: settings.siteDescription?.trim() || "",
      announcement: settings.announcement ?? "",
      supportContact: settings.supportContact?.trim() || "",
    },
  };
}
