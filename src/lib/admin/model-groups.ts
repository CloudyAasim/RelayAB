/**
 * src/lib/admin/model-groups.ts
 *
 * The models an account may be given, grouped by what they are for.
 *
 * ## Why
 *
 * The picker in the administrator's user page lists the union of two
 * catalogues — the conversation providers' model names and the media
 * providers' model names — and it used to be one flat alphabet. With a dozen
 * text models and a handful of image, video and speech models, "grant this
 * account the image models" meant reading every name and ticking the right
 * ones by hand.
 *
 * ## What decides a group
 *
 * - A **conversation provider's** models are text models. That is the kind the
 *   gateway serves on `/v1/chat/completions`, `/v1/responses` and the rest.
 * - A **media provider's** models are grouped by the capability of the spec
 *   that serves them — the same rule the model catalogue uses when it tells a
 *   client that a model produces images rather than text.
 *
 * The spec that serves a model is the one that names it, else the one that
 * serves every model of its capability, else the provider's first spec. That
 * rule is the catalogue's (`specServingModel`), and it is used here too, so
 * the picker and the catalogue can never disagree about what a model is.
 *
 * ## The order of the groups
 *
 * Text first — it is the biggest group and the one most accounts want — and
 * then the media kinds in the order the catalogue lists them. A group with no
 * models is not listed at all: an empty heading is a question the reader has
 * to answer.
 */
import type { Provider } from "@/lib/db/types";
import type { MediaCapability, MediaProvider } from "@/lib/media/spec";
import { specServingModel } from "@/lib/media/spec";

/** The kinds a model can be grouped under. */
export type ModelGroupKind =
  | "chat"
  | "image"
  | "video"
  | "tts"
  | "stt"
  | "translate"
  | "music";

export interface ModelGroup {
  kind: ModelGroupKind;
  /** The client-visible model names in this group, sorted. */
  models: string[];
}

/**
 * The groups, in the order they are shown.
 *
 * The order is the one the media capabilities are declared in, with the text
 * group first.
 */
const GROUP_ORDER: readonly ModelGroupKind[] = [
  "chat",
  "image",
  "video",
  "tts",
  "stt",
  "translate",
  "music",
];

/** The group a media capability belongs to. */
function groupForCapability(capability: MediaCapability | undefined): ModelGroupKind {
  switch (capability) {
    case "image.generate":
    case "image.edit":
      return "image";
    case "video.generate":
      return "video";
    case "audio.tts":
      return "tts";
    case "audio.stt":
      return "stt";
    case "audio.translate":
      return "translate";
    case "music.generate":
      return "music";
    default:
      // A capability this build does not know about still has to land
      // somewhere: the text group is the one that never lies about being
      // about text — but a media model in it would be a lie. So an unknown
      // capability goes to the group its name starts with, and only a
      // capability nobody can place falls back to text.
      return "chat";
  }
}

/**
 * Every model the deployment serves, grouped by kind.
 *
 * A model that appears in both catalogues — the same client name offered by a
 * conversation provider and by a media provider — lands in the media group,
 * because that is the more specific answer.
 */
export function groupModelsByKind(
  providers: Provider[],
  mediaProviders: MediaProvider[],
): ModelGroup[] {
  const byKind = new Map<ModelGroupKind, Set<string>>();

  const add = (kind: ModelGroupKind, model: string): void => {
    let bucket = byKind.get(kind);
    if (!bucket) {
      bucket = new Set<string>();
      byKind.set(kind, bucket);
    }
    bucket.add(model);
  };

  for (const provider of providers) {
    for (const model of Object.keys(provider.modelMapping)) {
      add("chat", model);
    }
  }

  for (const provider of mediaProviders) {
    for (const model of Object.keys(provider.models ?? {})) {
      const spec = specServingModel(provider, model);
      const kind = groupForCapability(spec?.capability);
      add(kind, model);
      // A media model also sits in the text group until the media group claims
      // it; the claim is the removal. A model whose kind *is* the text group
      // (only reachable for a capability this build does not know) keeps its
      // place — removing it would lose it from the list entirely.
      if (kind !== "chat") byKind.get("chat")?.delete(model);
    }
  }

  const groups: ModelGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const models = byKind.get(kind);
    if (!models || models.size === 0) continue;
    groups.push({ kind, models: Array.from(models).sort() });
  }
  return groups;
}

/** The flat list of every grouped model, for the count and the empty check. */
export function groupedModelIds(groups: ModelGroup[]): string[] {
  return groups.flatMap((group) => group.models);
}

/**
 * The models an account was granted, grouped by kind.
 *
 * Two lists come back: the granted models that the catalogue still knows
 * about, grouped as usual, and the ones it does not — a model that was taken
 * out of the catalogue after it was granted still has to be shown, because the
 * account can call it.
 */
export function groupAllowedModels(
  allowedModels: string[],
  groups: ModelGroup[],
): { groups: ModelGroup[]; others: string[] } {
  const known = new Set(groups.flatMap((group) => group.models));
  const used: ModelGroup[] = [];
  for (const group of groups) {
    const models = group.models.filter((model) => allowedModels.includes(model));
    if (models.length > 0) used.push({ kind: group.kind, models });
  }
  const others = allowedModels.filter((model) => !known.has(model)).sort();
  return { groups: used, others };
}
