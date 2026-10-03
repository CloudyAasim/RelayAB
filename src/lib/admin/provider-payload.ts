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
  textSpecs?: string[];
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
  upstreamFormat: "responses" | "chat";
  anthropicEnabled: boolean;
  anthropicBaseUrl: string | null;
  modelMapping: Record<string, string>;
  modelConfigs: Record<string, unknown>;
  textSpecs?: string[];
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
    // "anthropic" is the legacy single-face encoding and is rewritten on save.
    upstreamFormat: faces.upstreamFormat === "anthropic" ? "responses" : faces.upstreamFormat,
    anthropicEnabled: faces.anthropicEnabled,
    anthropicBaseUrl: faces.anthropicBaseUrl || null,
    modelMapping,
    modelConfigs,
    ...(options.textSpecs ? { textSpecs: options.textSpecs } : {}),
  };
}

/**
 * Read a stored row back into form values.
 *
 * Legacy rows (`upstreamFormat: "anthropic"`) read as "Anthropic only"; saving
 * rewrites them into the two-flag shape.
 */
export function facesFromProvider(provider: ProviderRecord): ProviderFacesValue {
  const format = provider.upstreamFormat ?? "responses";
  const anthropicOnly = format === "anthropic";
  return {
    openaiEnabled: provider.openaiEnabled ?? !anthropicOnly,
    upstreamFormat: anthropicOnly ? "responses" : format,
    anthropicEnabled: provider.anthropicEnabled ?? anthropicOnly,
    anthropicBaseUrl: provider.anthropicBaseUrl ?? "",
  };
}

export function headersToText(headers: Record<string, string> | null | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

export function modeForProvider(provider: Pick<ProviderRecord, "textSpecs">): "simple" | "advanced" {
  return provider.textSpecs?.length ? "advanced" : "simple";
}
