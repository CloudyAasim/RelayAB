/**
 * src/lib/protocol/text-specs.ts
 *
 * A provider's wire protocols, one per compatibility interface.
 *
 * **Why a list.** A provider that serves both `/v1/chat/completions` and
 * `/anthropic/v1/messages` has two parameter vocabularies: the second calls it
 * `stop_sequences` and `max_tokens` is required, the first calls it `stop` and
 * it is optional. One document could only describe one of them, so "which
 * interface am I configuring" became a question the operator had to answer
 * before they could configure anything. A list answers it per surface, and the
 * proxy picks the entry matching the one the client actually called.
 *
 * **No entry, no policy.** That is the whole default, and the reason a provider
 * needs none of this to be a working one: an absent list, an empty list, and an
 * entry for a different surface all mean "forward the request as sent".
 */
import { parseTextSpec, isTextProtocol, type TextProtocol, type TextSpec } from "./text-spec";

/**
 * The surfaces a client can call, and the entry that governs each.
 *
 * **One per endpoint the gateway actually serves**, and that is the constraint.
 * The spec governs the surface the *client* called, not the vendor's dialect: a
 * Gemini upstream reached through `/v1/chat/completions` is governed by the
 * `openai-chat` entry, because that is the vocabulary in the request.
 *
 * Which is also why there is no `gemini-generate` here. A preset for it was
 * offered until someone checked the route list and found there is no
 * `v1beta/models/*:generateContent` — so nothing would ever have selected it,
 * and offering it would have been a field that saves and does nothing.
 */
/** The two switches on the provider itself: which endpoints answer. */
export type ProviderFaceId = "openai" | "anthropic";

export const SURFACES = [
  { id: "openai-chat", clientPath: "/v1/chat/completions", face: "openai" },
  { id: "openai-responses", clientPath: "/v1/responses", face: "openai" },
  { id: "anthropic-messages", clientPath: "/anthropic/v1/messages", face: "anthropic" },
] as const satisfies ReadonlyArray<{ id: string; clientPath: string; face: ProviderFaceId }>;

export type SurfaceId = (typeof SURFACES)[number]["id"];

/**
 * Which face a surface belongs to.
 *
 * This is the join between the two controls that otherwise look unrelated and
 * answer the same question differently. The face toggle says "this provider
 * does not answer /v1/responses"; the protocol list offered to add an entry
 * for `/v1/responses` in the same breath. Declaring the mapping here means the
 * editor can offer only the surfaces a switched-on face can actually reach,
 * instead of leaving the operator to notice the contradiction themselves.
 */
export function faceOf(protocol: string): ProviderFaceId | null {
  if (!isTextProtocol(protocol)) return null;
  return SURFACES.find((s) => s.id === protocol)?.face ?? null;
}

/** One surface, as the stored string identifies it. */
export interface ProtocolEntry {
  protocol: string;
  spec: TextSpec;
}

/**
 * Parse the stored list, dropping anything unusable.
 *
 * A bad entry is dropped rather than failing the read: the row also carries the
 * provider's key, models and faces, and one malformed protocol document must not
 * take a working provider offline. It is dropped *silently* here and loudly in
 * the editor, which is where it can be fixed.
 */
export function readTextSpecs(provider: { textSpecs?: readonly string[] | null }): ProtocolEntry[] {
  const out: ProtocolEntry[] = [];
  for (const raw of provider.textSpecs ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = parseTextSpec(parsed);
    if (!result.ok) continue;
    if (out.some((e) => e.protocol === result.spec.protocol)) continue;
    out.push({ protocol: result.spec.protocol, spec: result.spec });
  }
  return out;
}

/** The entry governing one surface, or null. */
export function specForSurface(
  entries: readonly ProtocolEntry[],
  protocol: string,
): TextSpec | null {
  return entries.find((e) => e.protocol === protocol)?.spec ?? null;
}

/**
 * Which of a provider's two configurations is live.
 *
 * A row holds both: the faces that decide what answers, and the per-interface
 * rules that decide what happens to the parameters. They are two ways of
 * describing the same vendor, and the operator picks which one is in effect —
 * so the other one is kept, not thrown away, and nothing is lost by switching.
 *
 * A row written before the field existed has no opinion, so it keeps the
 * behaviour it always had: rules apply when it has any. Defaulting the other
 * way would silently stop them applying to every existing provider on upgrade.
 */
export function activeModeOf(provider: {
  activeMode?: string | null;
  textSpecs?: readonly string[] | null;
}): "simple" | "advanced" {
  if (provider.activeMode === "simple" || provider.activeMode === "advanced") {
    return provider.activeMode;
  }
  return provider.textSpecs?.length ? "advanced" : "simple";
}

/**
 * The rule that governs this surface *if that configuration is the live one*.
 *
 * Every proxy path goes through this rather than `specForSurface`, so "inactive"
 * is a fact the engine holds rather than a thing the interface says. Three
 * call sites exist and none of them should have to remember.
 */
export function activeSpecFor(
  provider: Parameters<typeof activeModeOf>[0],
  protocol: string,
): TextSpec | null {
  if (activeModeOf(provider) !== "advanced") return null;
  return specForSurface(readTextSpecs(provider), protocol);
}

/**
 * Validate a whole list the editor is about to send.
 *
 * Rejects a duplicate protocol outright: two entries for one surface means one
 * of them never runs, and which one is decided by array order — invisible to
 * whoever is editing.
 */
export function validateTextSpecs(
  raws: readonly string[],
): { ok: true; specs: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const specs: string[] = [];

  raws.forEach((raw, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      errors.push(`第 ${i + 1} 条不是合法 JSON：${e instanceof Error ? e.message : ""}`);
      return;
    }
    const result = parseTextSpec(parsed);
    if (!result.ok) {
      for (const message of result.errors) errors.push(`第 ${i + 1} 条：${message}`);
      return;
    }
    if (seen.has(result.spec.protocol)) {
      errors.push(`协议「${result.spec.protocol}」配置了两条，只有一条会生效`);
      return;
    }
    seen.add(result.spec.protocol);
    specs.push(raw);
  });

  return errors.length ? { ok: false, errors } : { ok: true, specs };
}

/** The surface a protocol governs, for the label. */
export function surfaceOf(protocol: string): string | null {
  if (!isTextProtocol(protocol)) return null;
  return SURFACES.find((s) => s.id === protocol)?.clientPath ?? null;
}

export type { TextProtocol };
