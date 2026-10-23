/**
 * src/lib/admin/provider-payload.ts
 *
 * The one place a provider's form values become a request body.
 *
 * **Why this exists.** The create modal and the edit modal were two hand-written
 * copies of the same form: the same ten fields, the same `validateTextSpecs`
 * guard, the same near-identical `JSON.stringify({...})`. They drifted, and the
 * drift is the bug history:
 *
 *  - the edit modal branched on the mode and took the name, base URL, API key
 *    and the whole model table off the screen in advanced mode;
 *  - `create` had a `headers` field the edit modal never sent, so a request
 *    header set at creation could not be changed afterwards 閳?not by any UI,
 *    at all;
 *  - the create path once forgot to persist `textSpecs`, leaving a protocol
 *    configured in the UI that was never written.
 *
 * None of those are interesting bugs on their own. They share a cause: two
 * definitions of one thing, and nothing comparing them. So there is now one
 * definition, it is a pure function, and it is testable without React.
 *
 * The genuine differences between creating and editing are *named* in
 * {@link ProviderPayloadOptions} rather than re-forked at each call site.
 */

import type { ProviderFacesValue, UpstreamFormat } from "@/app/(admin)/admin/providers/ProviderFacesField";
import { rowsToPayload, type ProviderModelRow } from "@/app/(admin)/admin/providers/model-rows";

/** The stored shape the edit form reads back. */
export interface ProviderRecord {
  name: string;
  kind: string;
  baseUrl: string | null;
  modelMapping: Record<string, string>;
  modelConfigs: Record<string, unknown>;
  enabled: boolean;
  priority?: number;
  headers?: Record<string, string> | null;
  upstreamFormat?: UpstreamFormat;
  openaiEnabled?: boolean;
  anthropicEnabled?: boolean;
  anthropicBaseUrl?: string | null;
  /** How the Anthropic face is served. Absent means "native", as it always was. */
  anthropicMode?: "native" | "translated";
  textSpecs?: string[];
  /** Which configuration is live. Absent/null = "follow the rules if any". */
  activeMode?: string | null;
}

/** Everything the form holds, as strings where the inputs are strings. */
export interface ProviderFormValues {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  priority: string;
  enabled: boolean;
  headers: string;
  faces: ProviderFacesValue;
  modelRows: ProviderModelRow[];
  textSpecs: string[];
  /**
   * Which of the two configurations is live.
   *
   * Part of `values` rather than separate state, because it is a thing that gets
   * saved. It used to be a second `useState` that the payload never read, which
   * is why the mode could be moved and then forgotten — the switch was decoration
   * and the row was the truth. One value, read by the builder, sent on save.
   */
  activeMode: "simple" | "advanced";
}

export interface ProviderPayload {
  name: string;
  kind: string;
  baseUrl: string | null;
  apiKey?: string;
  priority: number;
  enabled: boolean;
  headers?: Record<string, string>;
  openaiEnabled: boolean;
  /**
   * The upstream's own protocol — or `"anthropic"`, which means the OpenAI
   * surfaces are served **by translation** because the vendor only speaks
   * Anthropic.
   */
  upstreamFormat: "responses" | "chat" | "anthropic" | "gemini";
  anthropicEnabled: boolean;
  anthropicBaseUrl: string | null;
  /**
   * How the Anthropic face is served: the vendor's own `/v1/messages`, or the
   * gateway's translation of the request into the protocol the vendor does
   * speak.
   */
  anthropicMode: "native" | "translated";
  modelMapping: Record<string, string>;
  modelConfigs: Record<string, unknown>;
  textSpecs?: string[];
  /** Always sent: an explicit choice beats an inferred one on the next read. */
  activeMode: "simple" | "advanced";
}

export interface ProviderPayloadOptions {
  /**
   * Create falls back to the template id when the name is left blank; edit has
   * an existing name and no such fallback.
   */
  nameFallback?: string;
  /**
   * Create omits an empty key, which the API reads as "no key". Edit must send
   * `undefined` for a blank field, which the API reads as "keep the stored one"
   * 閳?the two mean opposite things, so this cannot be defaulted.
   */
  apiKey?: string;
  /**
   * `undefined` omits `textSpecs` entirely ("nothing configured"). `[]` sends an
   * empty list, which is how a saved list is cleared. Create only ever does the
   * first; edit must be able to do the second.
   */
  textSpecs?: string[];
}

/**
 * `Name: value` per line, blank lines ignored.
 *
 * Lives here because both forms accept a headers box and only one of them
 * actually sent it.
 */
export function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the request body.
 *
 * Pure on purpose: this is the piece the two modals used to disagree about, so
 * it has to be checkable by calling it twice and comparing keys.
 */
export function buildProviderPayload(
  values: ProviderFormValues,
  options: ProviderPayloadOptions = {},
): ProviderPayload {
  const { modelMapping, modelConfigs } = rowsToPayload(values.modelRows);
  const { name, kind, baseUrl, apiKey, priority, enabled, headers, faces } = values;

  return {
    name: name || options.nameFallback || "",
    kind,
    baseUrl: baseUrl || null,
    ...(apiKey ? { apiKey: options.apiKey ?? apiKey } : {}),
    priority: Number(priority) || 0,
    enabled,
    ...(parseHeaders(headers) ? { headers: parseHeaders(headers) } : {}),
    openaiEnabled: faces.openaiEnabled,
    /**
     * "anthropic" is kept, not rewritten.
     *
     * It used to be rewritten to "responses" on save, because at the time the
     * value could only mean "this row is Anthropic-only" — a fact the two
     * flags already said. Now it also says *how* the OpenAI face is served:
     * an Anthropic-format row whose OpenAI side is on is served **by
     * translation**, and rewriting it would silently turn the next request
     * into a Responses body pointed at an Anthropic-only upstream.
     */
    upstreamFormat: faces.upstreamFormat,
    anthropicEnabled: faces.anthropicEnabled,
    anthropicBaseUrl: faces.anthropicBaseUrl || null,
    anthropicMode: faces.anthropicMode,
    modelMapping,
    modelConfigs,
    // The whole list goes either way. Switching to simple turns the rules off;
    // it does not delete them, and a spec written while in advanced is still
    // here when they switch back.
    ...(options.textSpecs ? { textSpecs: options.textSpecs } : {}),
    activeMode: values.activeMode,
  };
}

/**
 * Read a stored row back into form values.
 *
 * A row whose upstream speaks Anthropic keeps saying so: its `upstreamFormat`
 * stays `"anthropic"` and the Anthropic side is on. That is what lets the
 * operator turn the OpenAI side on for such a row and have it mean "the
 * gateway translates" rather than "point the next request at a Responses
 * endpoint this vendor does not have".
 *
 * The face flags are still read from the row when it has them, so an old row
 * that never had flags keeps its old meaning: Anthropic only.
 */
export function facesFromProvider(provider: ProviderRecord): ProviderFacesValue {
  const stored = provider.upstreamFormat ?? "responses";
  /**
   * A row created for Anthropic says so in its vendor type, whatever the
   * stored dialect says.
   *
   * The form reports the **effective** dialect, not the stored one, so the
   * value written back is the one the engine acts on. Two traps close with
   * that: a row typed "anthropic" whose stored dialect still read "responses"
   * (which is what a new Anthropic row used to look like), and a row whose
   * stored dialect read "anthropic" while its vendor type said something
   * else — the engine would have called it Anthropic and the operator would
   * have read the dropdown as saying otherwise.
   */
  const anthropicOnly = stored === "anthropic" || provider.kind === "anthropic";
  return {
    openaiEnabled: provider.openaiEnabled ?? !anthropicOnly,
    upstreamFormat: anthropicOnly ? "anthropic" : stored,
    anthropicEnabled: provider.anthropicEnabled ?? anthropicOnly,
    anthropicBaseUrl: provider.anthropicBaseUrl ?? "",
    // A row written before the choice existed is served natively, which is what
    // it was doing before the choice existed.
    anthropicMode: provider.anthropicMode ?? "native",
  };
}

export function headersToText(headers: Record<string, string> | null | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
