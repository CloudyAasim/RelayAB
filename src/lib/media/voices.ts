/**
 * src/lib/media/voices.ts
 *
 * Every voice this deployment can speak with, in one list.
 *
 * A TTS client needs a `voice` value before it can make its first call, and the
 * only honest way to know which values are real is to ask: some vendors publish
 * a listing endpoint (MiniMax `POST /v1/get_voice`), and for the rest the set is
 * fixed and lives in the request schema (OpenAI has no listing endpoint at all —
 * its voices are a type union in the `voice` parameter). Both are first-class
 * sources here, because they are the two ways the question has an answer, not a
 * real source and a consolation prize. See `MediaVoiceCatalogue` in ./spec.
 *
 * Three things this file is careful about, each of which was a way to be wrong:
 *
 *  1. **A failed provider must not read as "no voices".** An empty `data: []`
 *     tells a client its account has no voices, which it will then cache and act
 *     on. A provider whose listing failed is reported in `unavailable` with the
 *     reason; the providers that did answer still contribute.
 *  2. **`models: null` is not `models: []`.** `null` means "nobody narrowed this
 *     voice", so it applies to every model the spec serves; `[]` would claim the
 *     voice works with no model at all, which is a different and wrong answer.
 *  3. **A declaration never overwrites the vendor.** When both sources name the
 *     same id, the vendor's entry wins field by field — it is the live account
 *     that said so, and a declaration is the operator's memory of it.
 *
 * The cache is process-local and deliberately so: a voice list changes when
 * somebody clones a voice, which is rare, and losing the cache on restart costs
 * one upstream call. Sharing it would mean invalidating it when a provider's
 * specs change, for a five-minute-old entry nobody misses.
 */
import { listMediaProviders } from "@/lib/db/media-providers";
import { discoverMedia } from "./engine";
import type { MediaProvider, MediaSpec, MediaVoiceEntry } from "./spec";

export interface CatalogueVoice {
  id: string;
  name: string | null;
  description: string | null;
  /** Client models this voice works with. `null` = NOT NARROWED: it applies to
   *  every model the spec serves. That is different from "unknown", which is
   *  why `narrowedBy` exists. */
  models: string[] | null;
  /** Where the entry itself came from. */
  source: "vendor" | "declared";
  /** Who supplied `models`: the vendor, the operator, or nobody. */
  narrowedBy: "vendor" | "declared" | null;
  provider: string;
}

export interface CatalogueResult {
  voices: CatalogueVoice[];
  /**
   * Configured providers that could not be read, with the reason.
   *
   * `provider` is the provider's **name** rather than its id: this is the field a
   * person acts on ("check the MiniMax key"), and an opaque id cannot be checked.
   * `voices[].provider` is the opposite case — a client-facing label built from
   * the client model names, which is what its own request will carry.
   */
  unavailable: Array<{ provider: string; reason: string }>;
}

/** Five minutes. A cloned voice appearing now is worth minutes, not seconds. */
const CACHE_TTL_MS = 300_000;

/** provider id → the voices it contributed, and when they were collected. */
const cache = new Map<string, { at: number; voices: CatalogueVoice[] }>();

/**
 * Drop every cached provider. Tests use it; nothing else has a reason to.
 *
 * Without it the five-minute cache makes every test order-dependent: a provider
 * created by one test answers from another one's memory.
 */
export function __resetVoiceCatalogueCacheForTest(): void {
  cache.clear();
}

/**
 * Name a spec contributes under.
 *
 * A provider may hold several specs — MiniMax video V1 and V2 are both
 * `video.generate` — and a client that sees one id twice cannot tell whether
 * they are the same voice. The id names the *client-facing* provider: the id it
 * passes as `model`, falling back to the spec's display name. The `displayName`
 * part matters because an operator may well have declared the same vendor voice
 * twice across two specs of different API versions, and those genuinely are two
 * different routes to it.
 */
function specLabel(provider: MediaProvider, spec: MediaSpec): string {
  const models = spec.models ?? [];
  const served = models.length > 0 ? models : Object.keys(provider.models ?? {});
  if (served.length > 0) return `${provider.id}:${served.join(",")}`;
  return `${provider.id}:${spec.displayName ?? spec.capability}`;
}

/** A declared entry: what the operator wrote, verbatim and no more. */
function fromDeclared(
  entry: MediaVoiceEntry,
  provider: string,
): CatalogueVoice | null {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const models = nonEmpty(entry.models);
  return {
    id,
    name: text(entry.name),
    description: text(entry.description),
    models,
    source: "declared",
    narrowedBy: models ? "declared" : null,
    provider,
  };
}

/**
 * A listed entry: an object or a bare id string.
 *
 * The string form is not a fallback — it is what vendors that return `["a","b"]`
 * actually say, and there is no name or description in it to recover. Anything
 * unusable (no id, not an object) is dropped here rather than being carried into
 * a list where a client would try to use it as a `voice` value.
 */
function fromListed(raw: unknown, provider: string): CatalogueVoice | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? fromListed({ id }, provider) : null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return null;
  const models = nonEmpty(entry.models);
  return {
    id,
    name: text(entry.name),
    description: text(entry.description),
    models,
    source: "vendor",
    narrowedBy: models ? "vendor" : null,
    provider,
  };
}

/**
 * The listed voices, one level deep.
 *
 * A vendor either answers with a flat list or with named buckets, and MiniMax
 * answers with buckets: `system_voice`, `voice_cloning` and `voice_generation`
 * are three separate arrays, and a cloned voice appears in a different bucket
 * from a built-in one. Flattening exactly one level is what lets one catalogue
 * cover both shapes — and one level, because a nested list would be a vendor
 * inventing structure the catalogue has no field for.
 */
function flatten(raw: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(raw)) {
    for (const entry of raw) out.push(entry);
    return out;
  }
  if (typeof raw === "object" && raw !== null) {
    for (const bucket of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(bucket)) out.push(...bucket);
    }
  }
  return out;
}

/** One provider's contribution: declared first, then the live listing over it. */
async function collectProvider(
  provider: MediaProvider,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ voices: CatalogueVoice[]; reason?: string }> {
  // Keyed by `provider/spec/id`: the id alone is not unique, because two specs of
  // one provider can carry the same voice and must not merge silently. The map is
  // also what the answer is read out of, because a merge replaces the entry that
  // is already in the list — appending the merged copy as well would report the
  // same voice twice, once of them stale.
  const index = new Map<string, CatalogueVoice>();

  const add = (voice: CatalogueVoice | null): void => {
    if (!voice) return;
    const key = `${voice.provider}/${voice.id}`;
    const existing = index.get(key);
    index.set(key, existing ? merge(existing, voice) : voice);
  };

  let reason: string | undefined;

  for (const spec of provider.specs ?? []) {
    const catalogue = spec.voices;
    if (!catalogue) continue;
    const providerLabel = specLabel(provider, spec);

    // Declared first and without a network call: OpenAI has no listing
    // endpoint, so for that provider this is the only source there is and it
    // must never be gated behind an upstream that does not exist.
    for (const entry of catalogue.declared ?? []) add(fromDeclared(entry, providerLabel));

    const remote = catalogue.remote;
    if (!remote) continue;
    const out = await discoverMedia({ spec, remote, provider, ...opts });
    if (!out.ok) {
      // Recorded, not thrown: one vendor being unreachable must not empty the
      // catalogue for every other provider. Not cached either — a failure that
      // outlived five minutes would keep reporting a vendor that has recovered.
      const why = `${out.error.code}: ${out.error.message}`;
      reason = reason ? `${reason}; ${why}` : why;
      continue;
    }
    const listed = (out.payload as { voices?: unknown } | null)?.voices;
    for (const entry of flatten(listed)) add(fromListed(entry, providerLabel));
  }

  // Map order, not append order: a declaration merged into by a listing keeps
  // the declaration's position, which is the order the reader already saw.
  return { voices: [...index.values()], ...(reason ? { reason } : {}) };
}

/**
 * Combine two entries for one id.
 *
 * The vendor wins for every field it actually supplies — including the ones it
 * is silent about, where the declaration is the better answer than `null`. What
 * it does not get to do is overwrite the vendor with a weaker claim: `models` is
 * all-or-nothing, because "the vendor narrowed this to two models" and "the
 * operator narrowed it to two models" are different claims and only the first
 * one is about the live account.
 */
function merge(existing: CatalogueVoice, incoming: CatalogueVoice): CatalogueVoice {
  const vendor = incoming.source === "vendor" ? incoming : existing.source === "vendor" ? existing : null;
  const other = vendor === incoming ? existing : incoming;
  return {
    id: vendor?.id ?? existing.id,
    name: vendor?.name ?? other.name,
    description: vendor?.description ?? other.description,
    models: vendor?.models ?? other.models,
    source: vendor?.source ?? "declared",
    narrowedBy: vendor?.narrowedBy ?? other.narrowedBy,
    provider: vendor?.provider ?? existing.provider,
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** A non-empty list of names, or null. `[]` and `"x"` are both "not narrowed". */
function nonEmpty(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names = value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim());
  return names.length > 0 ? names : null;
}

/**
 * Every voice this deployment can offer.
 *
 * `now` exists so the cache's expiry is testable without waiting five minutes;
 * it defaults to the clock and callers have no reason to pass it.
 */
export async function collectVoiceCatalogue(opts?: {
  now?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CatalogueResult> {
  const now = opts?.now ?? Date.now();
  const voices: CatalogueVoice[] = [];
  const unavailable: Array<{ provider: string; reason: string }> = [];

  // Every enabled provider, not just the one that would serve a particular
  // model: the caller is asking what exists, and a provider with no voice
  // catalogue simply contributes nothing.
  for (const provider of await listMediaProviders({ enabledOnly: true })) {
    const cached = cache.get(provider.id);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      voices.push(...cached.voices);
      continue;
    }

    const out = await collectProvider(provider, {
      ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    // Only success is cached, so the next call after a recovery re-reads the
    // vendor instead of replaying the failure for five minutes.
    if (!out.reason) cache.set(provider.id, { at: now, voices: out.voices });
    // The provider's *name*, not its id: this is the one field a person has to
    // act on — "check the MiniMax key" — and an opaque id cannot be checked.
    if (out.reason) unavailable.push({ provider: provider.name, reason: out.reason });
    voices.push(...out.voices);
  }

  return { voices, unavailable };
}